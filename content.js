(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;
  let timer = null;
  let scanTimer = null;
  let running = false;
  let isPurchased = false;
  let isPaymentClicked = false;
  let pendingOrder = null;
  let settings = {
    mode: "range",
    min: 100,
    max: 50000,
    fixed: 100,
    latency: 500,
    tab: "OTP-UPI",
    autoRefresh: true,
    autoBuy: true,
    autoPayment: true,
    soundAlarm: true,
    customAudioData: null,
    paymentMethod: "ANY",
    customPayment: ""
  };

  // If already loaded in this page context, clean up previous instance
  if (window.__arbBuyerInstance) {
    try {
      window.__arbBuyerInstance.stop();
    } catch(e) {}
  }

  // Ensure any lingering debug box or failed styles from previous versions are completely removed
  function removeOldDebug() {
    try {
      const box = document.getElementById("__otp_monitor_debug");
      if (box) box.remove();
    } catch(e) {}
    try {
      const oldFailedStyle = document.getElementById("__arb_failed_styles");
      if (oldFailedStyle) oldFailedStyle.remove();
    } catch(e) {}
  }
  removeOldDebug();
  try {
    const style = document.createElement("style");
    style.id = "__arb_cleaner";
    style.textContent = "#__otp_monitor_debug { display: none !important; opacity: 0 !important; pointer-events: none !important; }";
    (document.head || document.documentElement).appendChild(style);
  } catch(e) {}

  function log(...args) {
    console.log("[ARB Free Buyer]", ...args);
  }

  function findTargetTab(targetName = "OTP-UPI") {
    const norm = (targetName || "OTP-UPI").trim().toUpperCase();
    const tabs = [...document.querySelectorAll('[role="tab"], .van-tab')];
    return tabs.find(tab => {
      const titleEl = tab.querySelector(".tab-title, .van-tab__text");
      const text = (titleEl ? titleEl.textContent : tab.textContent || "").trim().toUpperCase();
      if (norm === "UPI") {
        // Match pure UPI and exclude OTP-UPI
        return (text.startsWith("UPI") || /\\bUPI\\b/.test(text)) && !text.includes("OTP");
      }
      return text.startsWith(norm) || text.includes(norm);
    });
  }

  function isTargetTabActive(targetName = "OTP-UPI") {
    const tab = findTargetTab(targetName);
    if (!tab) return false;
    return tab.getAttribute("aria-selected") === "true" ||
           tab.classList.contains("van-tab--active");
  }

  function realClick(el) {
    if (!el) return false;

    try { el.scrollIntoView({block: "nearest", inline: "nearest"}); } catch(e) {}
    try { el.focus(); } catch(e) {}

    const opts = {bubbles: true, cancelable: true, view: window, buttons: 1, button: 0};
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      try {
        el.dispatchEvent(new MouseEvent(type, opts));
      } catch(e) {}
    }
    try { el.click(); } catch(e) {}

    return true;
  }

  // Switch to target tab ONLY if not already active (never repeatedly during refresh loop!)
  function ensureTargetTab() {
    const targetName = settings.tab || "OTP-UPI";
    if (isTargetTabActive(targetName)) {
      return false; // Already active, do not click to prevent resetting to range page
    }
    const tab = findTargetTab(targetName);
    if (!tab) {
      log(`Target tab "${targetName}" not found`);
      return false;
    }
    log(`Switching to target tab "${targetName}"`);
    realClick(tab);
    setTimeout(() => {
      const current = findTargetTab(targetName);
      if (current && current.getAttribute("aria-selected") !== "true") {
        const child = current.querySelector(".tab-title, .van-tab__text, .van-tab__text-ellipsis");
        if (child) realClick(child);
      }
    }, 60);
    return true;
  }

  // Locate the filter / switch icon (smartChange.svg next to Tips banner)
  function findFilterButton() {
    return document.querySelector(".switch-btn") ||
           document.querySelector(".x-buyList-switchbar img") ||
           document.querySelector('img[src*="smartChange"]') ||
           document.querySelector(".x-buyList-switchbar .switch-btn") ||
           null;
  }

  // Verify if individual orders list is active (NOT the range page)
  function isIndividualMode() {
    return Boolean(
      document.querySelector(".x-buyList-filter") ||
      document.querySelector(".item[platformorder]") ||
      document.querySelector("[platformorder]")
    );
  }

  // Detect if page is in range mode (e.g. ₹100-200, no platformorder, or no .x-buyList-filter)
  function isRangeMode() {
    if (isIndividualMode()) return false;
    const items = document.querySelectorAll(".item");
    if (items.length > 0 && !items[0].hasAttribute("platformorder")) return true;
    if (document.querySelector(".range-paytag1, .range-paytag2, .range-paytag3")) return true;
    if (document.querySelector(".switch-btn") && !document.querySelector(".x-buyList-filter")) return true;
    return false;
  }

  let isSwitchingMode = false;
  let lastSwitchTime = 0;

  // Dedicated function to switch from Range Mode to Individual Mode ONCE with cooldown
  async function switchToIndividualMode() {
    if (isIndividualMode()) return true;
    const now = Date.now();
    // Cooldown: at least 1200ms between any switch-btn clicks to completely prevent toggling/bouncing
    if (isSwitchingMode || (now - lastSwitchTime < 1200)) return false;

    const switchBtn = findFilterButton();
    if (!switchBtn) {
      log("Switch button (switch-btn) not found");
      return false;
    }

    isSwitchingMode = true;
    lastSwitchTime = now;
    log("Range mode detected; switching to individual orders mode via switch-btn");

    realClick(switchBtn);

    // Wait up to 600ms for Vue to render individual mode (.x-buyList-filter)
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 50));
      if (isIndividualMode()) {
        log("Successfully transitioned to individual orders mode");
        break;
      }
    }

    isSwitchingMode = false;
    return isIndividualMode();
  }

  // Detect if current screen is login/registration or logged out
  function isLoginPage() {
    const hash = (window.location.hash || "").toLowerCase();
    const path = (window.location.pathname || "").toLowerCase();

    // If clearly on login/registration route
    if (hash.startsWith("#/login") || hash.startsWith("#/register") || hash.startsWith("#/forgot") ||
        path.startsWith("/login") || path.startsWith("/register")) {
      return true;
    }

    // Never consider it a login page if on order book, order detail, payment, or buy routes
    if (hash.includes("/buy/") || hash.includes("/order/") || hash.includes("/payment") || hash.includes("/pay") || hash.includes("/home")) {
      return false;
    }

    // Only if visible login form is rendered on an unauthenticated page
    const visibleLoginWrap = document.querySelector(".login-container, .login-wrap, form.login-form");
    if (visibleLoginWrap && visibleLoginWrap.offsetParent !== null) {
      return true;
    }

    return false;
  }

  // Detect if current screen is the payment / order confirmation page
  function isPaymentOrOrderSuccessPage() {
    if (isLoginPage()) return false;

    // Check DOM elements for payment page or order completion/cashier
    if (document.querySelector(".x-payment, .x-payment-payList, .x-payment-box, .bank-list, .x-popup-order")) {
      return true;
    }

    const hash = (window.location.hash || "").toLowerCase();
    if (hash && (
      hash.includes("/order/index") ||
      hash.includes("/order/cashier") ||
      hash.includes("/order/detail") ||
      hash.includes("/order/") ||
      hash.includes("/payment") ||
      hash.includes("/pay") ||
      hash.includes("/home/buy")
    )) {
      return true;
    }

    const titleEl = document.querySelector(".van-nav-bar__title, .navbar .title, .van-nav-bar");
    const titleText = (titleEl ? titleEl.textContent : "").trim().toLowerCase();
    if (titleText.includes("select method") || titleText.includes("payment") || titleText.includes("cashier") || titleText.includes("order detail")) {
      return true;
    }

    if (document.querySelector(".order-detail, .order-info, .select-method, .pay-type, .pay-list")) {
      return true;
    }

    return false;
  }

  // Automatically check and click the order popup (.x-popup-order) to redirect to payment page
  function checkOrderPopup() {
    const popup = document.querySelector(".x-popup-order");
    if (!popup) return false;
    try {
      if (window.getComputedStyle(popup).display === "none") return false;
    } catch(e) {}

    const btn = popup.querySelector(".btn.x-btn, .btn, button, .van-button");
    if (btn && !btn.disabled) {
      log("Order popup detected (.x-popup-order). Auto-clicking to redirect to payment page...");
      realClick(btn);
      const child = btn.querySelector(".van-button__text, .van-button__content");
      if (child) realClick(child);
      return true;
    }
    return false;
  }

  // Dynamic order book detector: works across any domain and route without relying on URLs
  function isOrderBookPage() {
    // If login / logout screen is visible
    if (isLoginPage()) {
      return false;
    }

    // If "Select Method Payment" or other payment/order screen is visible
    if (isPaymentOrOrderSuccessPage()) {
      return false;
    }

    // Must have the order book elements (tabs or buy list container)
    return Boolean(
      document.querySelector(".x-buyList") ||
      document.querySelector(".x-buyList-list") ||
      document.querySelector(".switch-btn") ||
      document.querySelector(".x-buyList-switchbar") ||
      document.querySelector('[role="tab"], .van-tab')
    );
  }

  function getCurrentActiveTabName() {
    const activeTab = document.querySelector('[role="tab"][aria-selected="true"], .van-tab--active, .van-tab.van-tab--line.van-tab--active');
    if (!activeTab) return null;
    const txt = (activeTab.textContent || "").trim().toUpperCase();
    if (txt.includes("OTP")) return "OTP-UPI";
    if (txt.startsWith("UPI")) return "UPI";
    if (txt.includes("BANK")) return "BANK";
    if (txt.includes("QUICK")) return "Quick";
    if (txt.includes("USDT")) return "USDT";
    return null;
  }

  // Click filter option (Default) in .x-buyList-filter to refresh individual orders
  // Strictly operates on the individual orders page; NEVER clicks switch-btn as fallback
  async function clickFilterOption() {
    if (!isOrderBookPage()) return false;

    // If currently in range mode, switch to individual mode once and return
    if (isRangeMode()) {
      await switchToIndividualMode();
      return false;
    }

    // Locate the filter option button ("Default ▾") in .x-buyList-filter
    const filterBtn = document.querySelector(".x-buyList-filter button.amount, .x-buyList-filter .van-popover__wrapper, .x-buyList-filter button");
    if (!filterBtn) {
      return false;
    }

    // Check if popover is already open
    let popover = document.querySelector(".van-popover");
    const isAlreadyOpen = popover && window.getComputedStyle(popover).display !== "none";
    if (!isAlreadyOpen) {
      realClick(filterBtn);
      // Wait briefly for popover to render
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 40));
        popover = document.querySelector(".van-popover");
        if (popover && window.getComputedStyle(popover).display !== "none") break;
      }
    }

    if (popover && window.getComputedStyle(popover).display !== "none") {
      const actions = Array.from(popover.querySelectorAll(".van-popover__action, .van-popover__action-text, [role='menuitem'], [role='button'], div, span"));
      const defaultAction = actions.find(el => (el.textContent || "").trim() === "Default") ||
                            actions.find(el => (el.textContent || "").trim().toLowerCase() === "default") ||
                            actions[0];
      if (defaultAction) {
        realClick(defaultAction);
        return true;
      }
    }

    return false;
  }

  let isRefreshing = false;
  let refreshLockTime = 0;

  // Refresh orders by clicking the filter option - never blocked by empty order book!
  async function refreshOrders() {
    if (!running || isPurchased || pendingOrder || isSwitchingMode) return;
    if (!isOrderBookPage()) return;

    // Safety timeout: if isRefreshing was true for more than 2 seconds, force-reset it so it never hangs!
    const now = Date.now();
    if (isRefreshing && (now - refreshLockTime < 2000)) return;

    // Don't refresh if page is currently showing an active loading spinner
    const loadingEl = document.querySelector(".van-loading, .van-toast--loading");
    if (loadingEl && (loadingEl.offsetWidth > 0 || loadingEl.offsetHeight > 0)) return;

    // If currently in range mode, switch to individual mode once and exit
    if (isRangeMode()) {
      await switchToIndividualMode();
      return;
    }

    isRefreshing = true;
    refreshLockTime = now;
    try {
      await clickFilterOption();
      if (running && !isPurchased && !pendingOrder) {
        scanOrders();
      }
    } catch (e) {
      log("Error during refresh:", e);
    } finally {
      isRefreshing = false;
    }
  }


  function findBuyButton(card) {
    if (!card) return null;
    return card.querySelector("button, .btn, .x-btn, .van-button");
  }

  // Ultra-fast buy button click with comprehensive event dispatch and child targeting
  function fastSnipeClick(btn) {
    if (!btn || btn.disabled) return false;
    try {
      btn.scrollIntoView({ block: "nearest", inline: "nearest" });
      btn.focus();
    } catch(e) {}

    const opts = { bubbles: true, cancelable: true, view: window, buttons: 1, button: 0 };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      try { btn.dispatchEvent(new MouseEvent(type, opts)); } catch(e) {}
    }
    try {
      if (typeof Touch !== "undefined" && typeof TouchEvent !== "undefined") {
        const t = new Touch({ identifier: Date.now(), target: btn, clientX: 100, clientY: 100 });
        btn.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [t], targetTouches: [t] }));
        btn.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], targetTouches: [] }));
      }
    } catch(e) {}
    try { btn.click(); } catch(e) {}

    const child = btn.querySelector(".van-button__text, .van-button__content");
    if (child) {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        try { child.dispatchEvent(new MouseEvent(type, opts)); } catch(e) {}
      }
      try { child.click(); } catch(e) {}
    }
    return true;
  }

  function clickBuyButton(card, amount) {
    const btn = findBuyButton(card);
    if (!btn || btn.disabled) return false;

    // Prevent double-clicking the exact same DOM element in rapid succession (< 500ms)
    const now = Date.now();
    if (btn._lastClickTime && (now - btn._lastClickTime < 500)) {
      return false;
    }
    btn._lastClickTime = now;

    const po = card.getAttribute("platformorder") || "";
    const orderId = po || getOrderId(card, amount);
    lastAttemptedOrder = { id: orderId, po, card, amount, time: now };
    log(`AUTO-BUY: Clicked Buy for ₹${amount || "?"} order=${po}`);

    realClick(btn);

    const child = btn.querySelector(".van-button__text, .van-button__content");
    if (child) {
      realClick(child);
    }
    return true;
  }

  let lastAttemptedOrder = null;

  // Track manual user clicks to assist with order tracking and payment navigation
  document.addEventListener("click", (e) => {
    const card = e.target.closest("[platformorder], .item");
    if (!card) return;
    const po = card.getAttribute("platformorder") || "";
    const amount = parseAmount(card);
    const id = po || getOrderId(card, amount);
    lastAttemptedOrder = { id, po, card, amount, time: Date.now() };

    // Check for failure toast shortly after manual click
    setTimeout(() => {
      const failToast = findFailureToast();
      if (failToast) {
        const toastRoot = failToast.element.closest(".van-toast, .van-popup, [class*='toast']") || failToast.element;
        toastRoot.setAttribute("data-arb-seen", "true");
        failToast.element.setAttribute("data-arb-seen", "true");
        handleOrderFailure(id, failToast.text);
      }
    }, 400);
  }, true);

  function getOrderId(card, amount) {
    if (!card) return "";
    const po = card.getAttribute("platformorder");
    if (po) return String(po);
    const orderId = card.getAttribute("data-id") || card.getAttribute("data-order-id") || card.id;
    if (orderId) return String(orderId);
    const limitEl = card.querySelector(".limit, [class*='limit']");
    const limitText = limitEl ? limitEl.textContent.trim() : "";
    return `${amount || ""}_${limitText}`;
  }

  // Fast direct amount reading from maximumamount attribute (0.001ms)
  function parseAmount(card) {
    if (!card) return NaN;
    const maxAttr = card.getAttribute("maximumamount");
    if (maxAttr) {
      const n = Number(maxAttr);
      if (!isNaN(n)) return n;
    }
    const amountNode = card.querySelector(".amount");
    if (amountNode) {
      const text = amountNode.textContent || "";
      const m = text.replace(/,/g, "").match(/([0-9]+(?:\.[0-9]+)?)/);
      if (m) return Number(m[1]);
    }
    return NaN;
  }

  function matches(amount) {
    if (!Number.isFinite(amount)) return false;
    if (settings.mode === "fixed") return amount === Number(settings.fixed);
    return amount >= Number(settings.min) && amount <= Number(settings.max);
  }

  // Fast comprehensive toast/popup lookup across all toast & dialog elements
  function findFailureToast() {
    const list = document.querySelectorAll(".van-toast, .van-dialog, [class*='toast'], .van-popup--center, [role='dialog'], [role='alert']");
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (el.getAttribute("data-arb-seen") === "true") continue;
      // Skip elements that are completely hidden
      if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) continue;
      const txt = (el.textContent || "").trim();
      if (!txt) continue;
      if (
        /bought by someone else/i.test(txt) ||
        /someone else/i.test(txt) ||
        /already bought/i.test(txt) ||
        /already taken/i.test(txt) ||
        /no longer available/i.test(txt) ||
        /order.*expired/i.test(txt) ||
        /order.*not exist/i.test(txt) ||
        /order.*invalid/i.test(txt) ||
        /please buy another/i.test(txt) ||
        /please refresh/i.test(txt) ||
        /已被他人购买|已被抢|订单已失效|已被买走|手慢了/.test(txt)
      ) {
        return { element: el, text: txt };
      }
    }
    return null;
  }

  // Helper: determine if an element or its children match the desired payment method
  function elementMatchesTarget(el, target, customKeyword = "") {
    if (!el) return false;
    if (
      el.classList.contains("disabled") ||
      el.getAttribute("aria-disabled") === "true" ||
      el.disabled
    ) {
      return false;
    }
    if (target === "any") return true;

    const rawText = (el.innerText || el.textContent || "").toLowerCase();
    const cleanText = rawText.replace(/[\s\-_]/g, "");
    const cls = (el.className || "").toString().toLowerCase();
    const cleanCls = cls.replace(/[\s\-_]/g, "");
    const elId = (el.id || "").toLowerCase().replace(/[\s\-_]/g, "");

    // 1. Check all nested images, SVGs, and background styles
    const imgs = el.querySelectorAll("img, svg, [style*='background']");
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      const src = (img.getAttribute("src") || "").toLowerCase().replace(/[\s\-_]/g, "");
      const alt = (img.getAttribute("alt") || "").toLowerCase().replace(/[\s\-_]/g, "");
      const title = (img.getAttribute("title") || "").toLowerCase().replace(/[\s\-_]/g, "");
      const imgCls = (img.className || "").toString().toLowerCase().replace(/[\s\-_]/g, "");

      if (target === "phonepe" && (src.includes("phonepe") || alt.includes("phonepe") || title.includes("phonepe") || imgCls.includes("phonepe") || src.includes("phone-pe") || src.includes("phone_pe") || src.includes("ybl"))) return true;
      if (target === "paytm" && (src.includes("paytm") || alt.includes("paytm") || title.includes("paytm") || imgCls.includes("paytm"))) return true;
      if (target === "supermoney" && (src.includes("supermoney") || alt.includes("supermoney") || title.includes("supermoney") || imgCls.includes("supermoney"))) return true;
      if (target === "navi" && (src.includes("navi") || alt.includes("navi") || imgCls.includes("navi"))) return true;
      if (target === "freecharge" && (src.includes("freecharge") || alt.includes("freecharge") || imgCls.includes("freecharge"))) return true;
      if (target === "moneyview" && (src.includes("moneyview") || alt.includes("moneyview") || imgCls.includes("moneyview"))) return true;
      if ((target === "gpay" || target === "googlepay") && (src.includes("gpay") || src.includes("google") || alt.includes("gpay") || alt.includes("google") || imgCls.includes("gpay"))) return true;
      if (target === "bhim" && (src.includes("bhim") || alt.includes("bhim") || imgCls.includes("bhim"))) return true;
      if (target === "cred" && (src.includes("cred") || alt.includes("cred") || imgCls.includes("cred"))) return true;
      if (customKeyword && (src.includes(customKeyword) || alt.includes(customKeyword))) return true;
    }

    // 2. Check data attributes on el or children
    const dataAttrs = ["data-type", "data-name", "data-channel", "data-method", "data-code", "data-pay", "data-val"];
    for (const attr of dataAttrs) {
      const val = (el.getAttribute(attr) || "").toLowerCase().replace(/[\s\-_]/g, "");
      if (target === "phonepe" && (val.includes("phonepe") || val.includes("ybl"))) return true;
      if (target === "paytm" && val.includes("paytm")) return true;
      if (target === "supermoney" && val.includes("supermoney")) return true;
      if (target === "navi" && val.includes("navi")) return true;
      if ((target === "gpay" || target === "googlepay") && (val.includes("gpay") || val.includes("google"))) return true;
      if (target === "bhim" && val.includes("bhim")) return true;
      if (customKeyword && val.includes(customKeyword)) return true;
    }

    // 3. Text & Class checks per payment target
    if (target === "phonepe") {
      return cleanText.includes("phonepe") || cleanCls.includes("phonepe") || elId.includes("phonepe") ||
             cleanText.includes("@ybl") || cleanText.includes("@ibl") || cleanText.includes("@axl") ||
             rawText.includes("phone pe") || rawText.includes("phonepe");
    }
    if (target === "paytm") {
      return cleanText.includes("paytm") || cleanCls.includes("paytm") || elId.includes("paytm") || cleanText.includes("@paytm");
    }
    if (target === "supermoney") {
      return cleanText.includes("supermoney") || cleanText.includes("super.money") || cleanCls.includes("supermoney") || cleanText.includes("@superyes");
    }
    if (target === "navi") {
      return cleanText.includes("navi") || cleanCls.includes("navi") || cleanText.includes("@naviaxis");
    }
    if (target === "freecharge") {
      return cleanText.includes("freecharge") || cleanCls.includes("freecharge");
    }
    if (target === "moneyview") {
      return cleanText.includes("moneyview") || cleanCls.includes("moneyview");
    }
    if (target === "gpay" || target === "googlepay") {
      return cleanText.includes("gpay") || cleanText.includes("googlepay") || cleanText.includes("google") ||
             cleanCls.includes("gpay") || cleanText.includes("@okhdfcbank") || cleanText.includes("@okaxis") || cleanText.includes("@oksbi") || cleanText.includes("@okicici");
    }
    if (target === "bhim") {
      return cleanText.includes("bhim") || cleanCls.includes("bhim") || cleanText.includes("@upi");
    }
    if (target === "cred") {
      return cleanText.includes("cred") || cleanCls.includes("cred");
    }
    if (target === "custom" && customKeyword) {
      const k = customKeyword.trim().toLowerCase();
      const cleanK = k.replace(/[\s\-_]/g, "");
      return cleanText.includes(cleanK) || rawText.includes(k) || cls.includes(k);
    }

    return cleanText.includes(target) || cleanCls.includes(target);
  }

  function findPaymentRow(preference = "ANY", customKeyword = "") {
    let target = (preference || "ANY").trim().toLowerCase();
    if (target === "custom" && customKeyword) {
      target = customKeyword.trim().toLowerCase();
    }
    if (!target) target = "any";

    // Pass 1: Check known container items (.x-payment-payList, .payList, .bank-list, .x-payment, etc.)
    const listContainers = document.querySelectorAll(
      ".x-payment-payList, .payList, .bank-list, .x-payment, .pay-list, .van-radio-group, .van-cell-group, .payment-list, .select-method"
    );
    for (let c = 0; c < listContainers.length; c++) {
      const container = listContainers[c];
      const rows = [...container.querySelectorAll(".item, .x-row, .van-cell, .van-radio, [class*='item'], [role='radio'], [role='button']")];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (elementMatchesTarget(row, target, customKeyword)) {
          return {
            element: row,
            section: "Payment List Item",
            text: (row.innerText || row.textContent || "").replace(/\n+/g, " ").trim()
          };
        }
      }
    }

    // Pass 2: Global scan for ANY element on the screen matching the target
    if (target !== "any") {
      const allCandidates = document.querySelectorAll(
        "[class*='phonepe'], [class*='paytm'], [class*='upi'], [class*='item'], [class*='row'], " +
        ".van-cell, .van-radio, button, div, span, p, img, a"
      );
      for (let i = 0; i < allCandidates.length; i++) {
        const el = allCandidates[i];
        if (elementMatchesTarget(el, target, customKeyword)) {
          const clickable = el.closest(".item, .x-row, .van-cell, .van-radio, button, [role='button'], [class*='item']") || el;
          return {
            element: clickable,
            section: "Global Screen Match",
            text: (clickable.innerText || clickable.textContent || "").replace(/\n+/g, " ").trim()
          };
        }
      }
    }

    // Pass 3: If target is "any", pick first available clickable payment row
    if (target === "any") {
      for (let c = 0; c < listContainers.length; c++) {
        const rows = [...listContainers[c].querySelectorAll(".item, .x-row, .van-cell, .van-radio")];
        if (rows.length > 0) {
          return {
            element: rows[0],
            section: "First Available",
            text: (rows[0].innerText || rows[0].textContent || "").replace(/\n+/g, " ").trim() || "First Available"
          };
        }
      }
    }

    // NO premature fallback when searching for a specific method like PhonePe!
    return null;
  }

  // Click any primary confirmation / submit button on the payment cashier screen if present
  function clickPaymentSubmitButton() {
    const candidates = document.querySelectorAll(
      ".x-payment .btn, .x-payment button, .x-payment-btn, .x-payment-bottom button, " +
      ".van-button--primary, .van-button--danger, .submit-btn, .pay-btn, .btn-pay, " +
      "button[class*='pay'], button[class*='confirm'], button[class*='submit'], " +
      ".bank-list ~ button, .x-payment-payList ~ button, .payList ~ button, .van-button"
    );
    for (let i = 0; i < candidates.length; i++) {
      const btn = candidates[i];
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") continue;
      if (btn.offsetWidth === 0 && btn.offsetHeight === 0) continue;
      const txt = (btn.textContent || "").trim().toLowerCase();
      if (txt.includes("cancel") || txt.includes("back") || txt.includes("return")) continue;
      if (
        txt.includes("pay") || txt.includes("confirm") || txt.includes("submit") ||
        txt.includes("proceed") || txt.includes("continue") || txt.includes("支付") || txt.includes("确认") ||
        btn.classList.contains("van-button--primary") || btn.classList.contains("btn-pay")
      ) {
        log(`AUTO-PAY: Clicking payment cashier confirmation button: "${txt}"`);
        realClick(btn);
        const child = btn.querySelector(".van-button__text, .van-button__content");
        if (child) realClick(child);
        return true;
      }
    }
    return false;
  }

  // Multi-tier click to ensure PhonePe is activated across all Vue / mobile event handlers
  function clickPaymentElement(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch(e) {}
    try { el.focus(); } catch(e) {}

    // Dispatch full mouse & pointer & touch events
    const opts = { bubbles: true, cancelable: true, view: window, buttons: 1, button: 0 };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      try { el.dispatchEvent(new MouseEvent(type, opts)); } catch(e) {}
    }
    try {
      if (typeof Touch !== "undefined" && typeof TouchEvent !== "undefined") {
        const t = new Touch({ identifier: Date.now(), target: el, clientX: 100, clientY: 100 });
        el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [t], targetTouches: [t] }));
        el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], targetTouches: [] }));
      }
    } catch(e) {}
    try { el.click(); } catch(e) {}

    // Also click any radio button, checkbox, button, icon, or text child
    const innerTargets = el.querySelectorAll("input[type='radio'], input[type='checkbox'], .van-radio, .van-radio__icon, .van-radio__label, button, .btn, .x-btn, .van-button, .van-cell__title, .van-cell__value, [role='radio'], img, span");
    for (let i = 0; i < innerTargets.length; i++) {
      const child = innerTargets[i];
      try { child.dispatchEvent(new MouseEvent("click", opts)); } catch(e) {}
      try { child.click(); } catch(e) {}
    }

    // After 250ms, check if there is an explicit "Pay / Confirm" button on the cashier screen
    setTimeout(() => {
      clickPaymentSubmitButton();
    }, 250);

    return true;
  }

  let isPaymentSelecting = false;

  function autoSelectPaymentMethod(timeout = 10000) {
    if (settings.autoPayment === false || isPaymentClicked || isPaymentSelecting) return Promise.resolve(false);

    const preference = settings.paymentMethod || "ANY";
    const customKeyword = settings.customPayment || "";
    if (preference === "none") return Promise.resolve(false);

    isPaymentSelecting = true;
    const start = Date.now();
    log(`AUTO-PAY: Actively scanning for payment method "${preference}" (timeout=${timeout}ms)...`);

    return new Promise(resolve => {
      const checkIntv = setInterval(() => {
        if (isPaymentClicked) {
          clearInterval(checkIntv);
          isPaymentSelecting = false;
          return resolve(true);
        }

        const match = findPaymentRow(preference, customKeyword);
        if (match && match.element) {
          clearInterval(checkIntv);
          isPaymentClicked = true;
          isPaymentSelecting = false;
          log(`AUTO-PAY: Successfully identified [${match.section}] "${match.text}" (target: ${preference}). Clicking...`);
          clickPaymentElement(match.element);
          try {
            api.runtime.sendMessage({
              type: "PAYMENT_METHOD_CLICKED",
              method: preference,
              section: match.section,
              text: match.text
            });
          } catch (e) {}
          return resolve(true);
        }

        if (Date.now() - start >= timeout) {
          clearInterval(checkIntv);
          isPaymentSelecting = false;
          log(`AUTO-PAY: Timeout after ${timeout}ms waiting for payment method "${preference}"`);
          resolve(false);
        }
      }, 50);
    });
  }

  let alarmAudio = null;
  let alarmInterval = null;

  function stopAlarm() {
    if (alarmInterval) {
      clearInterval(alarmInterval);
      alarmInterval = null;
    }
    if (alarmAudio) {
      try {
        alarmAudio.pause();
        alarmAudio.currentTime = 0;
      } catch (e) {}
      alarmAudio = null;
    }
    const banner = document.getElementById("__arb_alarm_banner");
    if (banner) banner.remove();
  }

  function playSynthAlarm() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [880, 1174.66, 1396.91, 1760];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.12);
        gain.gain.setValueAtTime(0.35, ctx.currentTime + idx * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.12 + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.12);
        osc.stop(ctx.currentTime + idx * 0.12 + 0.22);
      });
    } catch (e) {}
  }

  function showAlarmBanner(amount) {
    let banner = document.getElementById("__arb_alarm_banner");
    if (banner) banner.remove();

    banner = document.createElement("div");
    banner.id = "__arb_alarm_banner";
    banner.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;background:linear-gradient(135deg,#00e676,#00b848);color:#06190f;padding:12px 18px;border-radius:12px;box-shadow:0 8px 32px rgba(0,230,118,0.5);display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:12px;font-family:system-ui,-apple-system,sans-serif;font-weight:700;font-size:14px;max-width:calc(100vw - 24px);box-sizing:border-box;text-align:center;";

    const amtStr = amount ? `₹${amount}` : "";
    const textSpan = document.createElement("span");
    textSpan.textContent = `🎉 Order Successfully Bought! ${amtStr}`;

    const stopBtn = document.createElement("button");
    stopBtn.id = "__arb_stop_alarm_btn";
    stopBtn.style.cssText = "background:#06190f;color:#00e676;border:0;padding:8px 16px;border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;min-height:36px;touch-action:manipulation;";
    stopBtn.textContent = "🔇 Stop Alarm";
    stopBtn.onclick = () => stopAlarm();

    banner.appendChild(textSpan);
    banner.appendChild(stopBtn);
    (document.body || document.documentElement).appendChild(banner);
  }

  function playSuccessAlarm(amount) {
    if (settings.soundAlarm === false) return;

    showAlarmBanner(amount);

    const audioSrc = settings.customAudioData || (api && api.runtime ? api.runtime.getURL("alarm.mp3") : null);

    const playAudioCycle = () => {
      if (!audioSrc) return playSynthAlarm();
      try {
        if (!alarmAudio) {
          alarmAudio = new Audio(audioSrc);
        }
        alarmAudio.currentTime = 0;
        alarmAudio.play().catch(() => {
          playSynthAlarm();
        });
      } catch (e) {
        playSynthAlarm();
      }
    };

    playAudioCycle();
    let cycles = 0;
    alarmInterval = setInterval(() => {
      cycles++;
      if (cycles > 8) {
        stopAlarm();
        return;
      }
      playAudioCycle();
    }, 3500);
  }

  function handleOrderSuccess(orderId, amount) {
    if (isPurchased) {
      if (settings.autoPayment !== false && !isPaymentClicked) {
        autoSelectPaymentMethod(10000);
      }
      return;
    }

    // Safety guard: if on login page, definitely not an order success
    if (isLoginPage()) {
      log("Login page detected; not a successful order. Stopping bot.");
      stop();
      return;
    }

    const activeOrder = pendingOrder || lastAttemptedOrder;
    let finalOrderId = orderId || (activeOrder ? activeOrder.id : "");
    let finalAmount = amount || (activeOrder ? activeOrder.amount : "");

    if (!finalAmount) {
      try {
        const amtEl = document.querySelector(".x-payment .amount, .x-payment-top .amount, [class*='amount']");
        if (amtEl) {
          const digits = (amtEl.textContent || "").replace(/[^\d.]/g, "");
          if (digits) finalAmount = digits;
        }
      } catch (e) {}
    }

    isPurchased = true;
    pendingOrder = null;
    log(`Order ₹${finalAmount || "?"} (${finalOrderId || "?"}) successfully purchased! Turning off buying process.`);

    // Halt buying and refreshing loops while keeping the payment watcher running
    running = false;
    isRefreshing = false;
    isSwitchingMode = false;
    if (timer) clearInterval(timer);
    if (scanTimer) clearInterval(scanTimer);
    timer = scanTimer = null;

    // Sound alarm immediately to alert user
    playSuccessAlarm(finalAmount);

    try {
      api.runtime.sendMessage({
        type: "ORDER_PURCHASED",
        amount: finalAmount,
        order: finalOrderId
      });
    } catch (e) {}

    // Auto-select payment method on order success
    if (settings.autoPayment !== false) {
      autoSelectPaymentMethod(10000);
    }
  }

  function handleOrderFailure(orderId, reason) {
    log(`Order (${orderId || "?"}) not confirmed / failed: "${reason}". Keeping order active and resuming monitoring...`);
    pendingOrder = null;

    // Fast refresh to fetch latest orders immediately
    setTimeout(() => {
      if (running && !isPurchased) {
        refreshOrders();
      }
    }, 40);
  }

  function waitForBuyOutcome(attempt) {
    const checkInterval = 40;
    const timeout = 1800; // Fast 1.8s timeout: don't freeze sniper when order is taken by someone else
    const startTime = Date.now();

    const checkTimer = setInterval(() => {
      if (!running || isPurchased || !pendingOrder || pendingOrder.id !== attempt.id) {
        clearInterval(checkTimer);
        return;
      }

      // Check if logged out
      if (isLoginPage()) {
        clearInterval(checkTimer);
        log("Logged out / login page detected while waiting for buy outcome.");
        handleOrderFailure(attempt.id, "Session expired / Logged out");
        return;
      }

      // 1. Check for failure toast across all toast elements
      const failToast = findFailureToast();
      if (failToast) {
        clearInterval(checkTimer);
        const toastRoot = failToast.element.closest(".van-toast, .van-popup, [class*='toast']") || failToast.element;
        toastRoot.setAttribute("data-arb-seen", "true");
        failToast.element.setAttribute("data-arb-seen", "true");
        handleOrderFailure(attempt.id, failToast.text);
        return;
      }

      // 2. Check if Order Popup appeared (.x-popup-order)
      if (checkOrderPopup()) {
        clearInterval(checkTimer);
        handleOrderSuccess(attempt.id, attempt.amount);
        return;
      }

      // 3. Check if screen navigated to payment / order screen (Success!)
      if (isPaymentOrOrderSuccessPage() || (!isOrderBookPage() && !isLoginPage())) {
        clearInterval(checkTimer);
        handleOrderSuccess(attempt.id, attempt.amount);
        return;
      }

      // 4. Check if loading spinner is currently visible
      const loadingEl = document.querySelector(".van-loading, .van-toast--loading");
      const isVisibleLoading = loadingEl && (loadingEl.offsetWidth > 0 || loadingEl.offsetHeight > 0);
      if (isVisibleLoading && (Date.now() - startTime < 3000)) {
        return; // Allow briefly up to 3.0s only while active loading spinner is visible
      }

      // 5. Timeout check: still on order book without confirmation -> order failed/taken by someone else
      if (Date.now() - startTime >= timeout) {
        clearInterval(checkTimer);
        log(`Order (${attempt.id}) not confirmed within ${timeout}ms. Resuming monitoring immediately.`);
        handleOrderFailure(attempt.id, "Order taken or not confirmed");
      }
    }, checkInterval);
  }

  // Scan only individual orders - ultra-fast single pass (0.3ms)
  function scanOrders() {
    if (!running || isPurchased || pendingOrder) return;
    if (!isOrderBookPage() || !isIndividualMode()) return;

    const cards = document.querySelectorAll(".item[platformorder], [platformorder]");
    const len = cards.length;
    if (len === 0) return;

    for (let i = 0; i < len; i++) {
      const card = cards[i];
      const po = card.getAttribute("platformorder");

      const amount = parseAmount(card);
      if (!matches(amount)) continue;

      const orderId = po || getOrderId(card, amount);

      if (settings.autoBuy) {
        const btn = findBuyButton(card);
        if (!btn || btn.disabled) continue;

        const now = Date.now();
        if (btn._lastClickTime && (now - btn._lastClickTime < 500)) continue;
        btn._lastClickTime = now;

        pendingOrder = {
          id: orderId,
          po: po || "",
          amount: amount,
          card: card,
          timestamp: now
        };
        lastAttemptedOrder = pendingOrder;
        log(`AUTO-BUY: Sniping order ₹${amount} (${orderId})!`);

        fastSnipeClick(btn);

        waitForBuyOutcome(pendingOrder);
        return;
      }
    }
  }

  let observer = null;

  function stop() {
    running = false;
    isPurchased = false;
    isPaymentClicked = false;
    pendingOrder = null;
    isRefreshing = false;
    isSwitchingMode = false;
    if (timer) clearInterval(timer);
    if (scanTimer) clearInterval(scanTimer);
    timer = scanTimer = null;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    log("Stopped");
  }

  function start(s) {
    stop();
    stopAlarm();
    isPurchased = false;
    isPaymentClicked = false;
    pendingOrder = null;
    removeOldDebug();
    settings = Object.assign(settings, s || {});
    const parsedLatency = Number(settings.latency);
    settings.latency = isNaN(parsedLatency) ? 500 : Math.max(0, parsedLatency);
    settings.fixed = isNaN(Number(settings.fixed)) ? 0 : Math.max(0, Number(settings.fixed));
    let minVal = isNaN(Number(settings.min)) ? 0 : Math.max(0, Number(settings.min));
    let maxVal = isNaN(Number(settings.max)) ? minVal + 1 : Math.max(0, Number(settings.max));
    if (minVal >= maxVal) {
      if (minVal > maxVal) {
        [minVal, maxVal] = [maxVal, minVal];
      } else {
        maxVal = minVal + 1;
      }
    }
    settings.min = minVal;
    settings.max = maxVal;
    settings.tab = settings.tab || "OTP-UPI";
    settings.autoBuy = settings.autoBuy !== false;
    settings.autoPayment = settings.autoPayment !== false;

    // If already on login page, abort start
    if (isLoginPage()) {
      log("Cannot start: User is logged out / on login page. Please log in first.");
      stop();
      return;
    }

    // If already on payment screen at start, trigger payment method selection immediately
    if ((document.querySelector(".x-payment, .x-payment-payList, .bank-list") || isPaymentOrOrderSuccessPage()) && settings.autoPayment !== false) {
      log("Already on payment screen; auto-selecting payment method");
      autoSelectPaymentMethod();
      return;
    }

    running = true;
    log(`Started; tab=${settings.tab}; latency=${settings.latency}ms; autoBuy=${settings.autoBuy}; autoPayment=${settings.autoPayment}`);

    // Watch DOM for when order is bought or screen switches away from buy list
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      // Check if logged out / login page appeared
      if (isLoginPage()) {
        log("Logged out / login page detected in observer. Stopping bot.");
        stop();
        return;
      }

      // Auto-click Order Popup (.x-popup-order) if shown
      if (checkOrderPopup()) {
        const orderId = pendingOrder ? pendingOrder.id : (lastAttemptedOrder ? lastAttemptedOrder.id : "");
        const amount = pendingOrder ? pendingOrder.amount : (lastAttemptedOrder ? lastAttemptedOrder.amount : "");
        handleOrderSuccess(orderId, amount);
        return;
      }

      // Check if payment screen appeared
      if ((document.querySelector(".x-payment, .x-payment-payList, .bank-list") || isPaymentOrOrderSuccessPage()) && settings.autoPayment !== false && !isPaymentClicked) {
        autoSelectPaymentMethod();
      }

      if (!running || isPurchased) return;

      // Real-time zero-delay sniper: scan the exact millisecond Vue adds cards to DOM!
      if (!pendingOrder && isOrderBookPage() && isIndividualMode()) {
        scanOrders();
      }

      // Only check failure toast if an order attempt is active
      if (pendingOrder) {
        const failToast = findFailureToast();
        if (failToast) {
          const toastRoot = failToast.element.closest(".van-toast, .van-popup, [class*='toast']") || failToast.element;
          toastRoot.setAttribute("data-arb-seen", "true");
          failToast.element.setAttribute("data-arb-seen", "true");
          handleOrderFailure(pendingOrder.id, failToast.text);
          return;
        }
      }

      // Check if screen changed to payment/order screen
      if (isPaymentOrOrderSuccessPage() || (!isOrderBookPage() && !isLoginPage())) {
        const orderId = pendingOrder ? pendingOrder.id : (lastAttemptedOrder ? lastAttemptedOrder.id : "");
        const amount = pendingOrder ? pendingOrder.amount : (lastAttemptedOrder ? lastAttemptedOrder.amount : "");
        handleOrderSuccess(orderId, amount);
      }
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    // If needed, switch tab ONCE at start (never continuously in refresh loop!)
    const switchedTab = ensureTargetTab();

    // Sequence startup: switch tab -> switch to individual mode -> start loops
    (async () => {
      if (switchedTab) {
        log(`Switched to target tab ${settings.tab}, waiting for tab DOM...`);
        await new Promise(r => setTimeout(r, 250));
      }
      if (!running || isPurchased) return;

      if (!isIndividualMode()) {
        log("Not in individual mode at startup; switching now...");
        await switchToIndividualMode();
        await new Promise(r => setTimeout(r, 150));
      }

      if (!running || isPurchased) return;

      log("Individual orders mode established; starting scan & refresh loops");

      // Initial scan
      scanOrders();

      // Start auto-refresh interval strictly AFTER individual mode is established
      if (settings.autoRefresh && !timer) {
        const refreshInterval = Math.max(200, settings.latency);
        timer = setInterval(() => {
          if (!running || isPurchased || pendingOrder) return;
          refreshOrders();

          setTimeout(() => {
            if (running && !isPurchased && !pendingOrder) scanOrders();
          }, 120);
        }, refreshInterval);
      }
    })();

    // High frequency order scanner to instantly catch orders when DOM updates
    scanTimer = setInterval(() => {
      if (running) scanOrders();
    }, 80);
  }

  window.__arbBuyerInstance = {
    stop,
    start,
    getStatus: () => ({ running, tab: settings.tab || "OTP-UPI" })
  };

  if (window.__arbBuyerMessageListener) {
    try {
      api.runtime.onMessage.removeListener(window.__arbBuyerMessageListener);
    } catch (e) {}
  }

  const messageHandler = (msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "START") {
      start(msg);
      if (sendResponse) sendResponse({ ok: true });
      return Promise.resolve({ ok: true });
    } else if (msg.type === "STOP") {
      stop();
      if (sendResponse) sendResponse({ ok: true });
      return Promise.resolve({ ok: true });
    } else if (msg.type === "CLICK_TAB") {
      ensureTargetTab();
      if (sendResponse) sendResponse({ ok: true });
      return Promise.resolve({ ok: true });
    } else if (msg.type === "CLICK_PAYMENT_METHOD") {
      isPaymentClicked = false;
      if (msg.paymentMethod) settings.paymentMethod = msg.paymentMethod;
      if (msg.customPayment) settings.customPayment = msg.customPayment;
      settings.autoPayment = true;
      autoSelectPaymentMethod();
      if (sendResponse) sendResponse({ ok: true });
      return Promise.resolve({ ok: true });
    } else if (msg.type === "GET_STATUS") {
      const activeOnPage = getCurrentActiveTabName();
      const res = {
        running,
        tab: settings.tab || activeOnPage || "OTP-UPI",
        activeOnPage,
        paymentMethod: settings.paymentMethod || "ANY",
        isLoginPage: isLoginPage()
      };
      if (sendResponse) sendResponse(res);
      return Promise.resolve(res);
    }
  };

  function checkNavigation() {
    if (isLoginPage()) {
      log("Login page detected on navigation; stopping bot");
      stop();
      return;
    }
    if (checkOrderPopup()) {
      const orderId = pendingOrder ? pendingOrder.id : (lastAttemptedOrder ? lastAttemptedOrder.id : "");
      const amount = pendingOrder ? pendingOrder.amount : (lastAttemptedOrder ? lastAttemptedOrder.amount : "");
      handleOrderSuccess(orderId, amount);
      return;
    }
    if ((document.querySelector(".x-payment, .x-payment-payList, .bank-list") || isPaymentOrOrderSuccessPage()) && settings.autoPayment !== false && !isPaymentClicked) {
      log("Payment screen reached on navigation; triggering autoSelectPaymentMethod");
      autoSelectPaymentMethod(10000);
      return;
    }
    if (running && (isPaymentOrOrderSuccessPage() || (!isOrderBookPage() && !isLoginPage()))) {
      const orderId = pendingOrder ? pendingOrder.id : (lastAttemptedOrder ? lastAttemptedOrder.id : "");
      const amount = pendingOrder ? pendingOrder.amount : (lastAttemptedOrder ? lastAttemptedOrder.amount : "");
      handleOrderSuccess(orderId, amount);
    }
  }

  window.addEventListener("hashchange", checkNavigation);
  window.addEventListener("popstate", checkNavigation);

  // Load saved preferences on init
  try {
    const raw = localStorage.getItem("arb_preferences");
    if (raw) {
      const p = JSON.parse(raw);
      if (p) {
        if (p.autoPayment !== undefined) settings.autoPayment = p.autoPayment;
        if (p.paymentMethod) settings.paymentMethod = p.paymentMethod;
        if (p.customPayment) settings.customPayment = p.customPayment;
      }
    }
  } catch(e) {}

  // If already on payment / cashier screen on load or reload, auto-select payment method
  if ((document.querySelector(".x-payment, .x-payment-payList, .bank-list") || isPaymentOrOrderSuccessPage()) && settings.autoPayment !== false && !isPaymentClicked) {
    log("Payment / cashier page detected on script load; triggering auto-select payment method");
    autoSelectPaymentMethod(10000);
  }

  window.__arbBuyerMessageListener = messageHandler;
  api.runtime.onMessage.addListener(messageHandler);
})();
