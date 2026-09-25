(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;
  let timer = null;
  let scanTimer = null;
  let running = false;
  let isPurchased = false;
  let isPaymentClicked = false;
  let pendingOrder = null;
  const failedOrders = new Set();
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
    refreshOption: "Large",
    paymentMethod: "ANY",
    customPayment: ""
  };

  // If already loaded in this page context, clean up previous instance
  if (window.__arbBuyerInstance) {
    try {
      window.__arbBuyerInstance.stop();
    } catch(e) {}
  }

  // Ensure any lingering debug box from previous versions is completely removed
  function removeOldDebug() {
    try {
      const box = document.getElementById("__otp_monitor_debug");
      if (box) box.remove();
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
    if (hash.includes("login") || hash.includes("signin") || hash.includes("register") ||
        path.includes("login") || path.includes("signin") || path.includes("register")) {
      return true;
    }

    const titleEl = document.querySelector(".van-nav-bar__title, .navbar .title, .van-nav-bar");
    const titleText = (titleEl ? titleEl.textContent : "").trim().toLowerCase();
    if (titleText.includes("login") || titleText.includes("sign in") || titleText.includes("log in") || titleText.includes("register")) {
      return true;
    }

    // Check for login forms / password inputs
    if (document.querySelector("input[type='password'], .login-container, .login-wrap, .login-form")) {
      return true;
    }

    return false;
  }

  // Detect if current screen is the payment / order confirmation page
  function isPaymentOrOrderSuccessPage() {
    if (isLoginPage()) return false;

    if (document.querySelector(".bank-list")) return true;

    const titleEl = document.querySelector(".van-nav-bar__title, .navbar .title, .van-nav-bar");
    const titleText = (titleEl ? titleEl.textContent : "").trim().toLowerCase();
    if (titleText.includes("select method") || titleText.includes("payment") || titleText.includes("order detail")) {
      return true;
    }

    const hash = (window.location.hash || "").toLowerCase();
    if (hash && (hash.includes("/order/") || hash.includes("/detail") || hash.includes("/payment") || hash.includes("/pay/"))) {
      return true;
    }

    if (document.querySelector(".order-detail, .order-info, .select-method, .pay-type, .pay-list")) {
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
      const chosen = (settings.refreshOption || "Large").trim().toLowerCase();

      // Find action matching user preference ("Large", "Default", or "Small")
      const matchedAction = actions.find(el => (el.textContent || "").trim().toLowerCase() === chosen) ||
                            actions.find(el => (el.textContent || "").trim().toLowerCase() === "large") ||
                            actions.find(el => (el.textContent || "").trim().toLowerCase() === "default") ||
                            actions[0];
      if (matchedAction) {
        realClick(matchedAction);
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

    // Don't refresh if page is currently busy with loading spinner
    if (document.querySelector(".van-loading, .van-toast--loading")) return;

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

  // Ultra-fast buy button click with ZERO layout reflow and ZERO focus delay (sub-millisecond)
  function fastSnipeClick(btn) {
    if (!btn || btn.disabled) return false;
    try {
      const opts = { bubbles: true, cancelable: true, view: window, buttons: 1, button: 0 };
      btn.dispatchEvent(new PointerEvent("pointerdown", opts));
      btn.dispatchEvent(new MouseEvent("mousedown", opts));
      btn.dispatchEvent(new PointerEvent("pointerup", opts));
      btn.dispatchEvent(new MouseEvent("mouseup", opts));
    } catch (e) {}
    try {
      btn.click();
    } catch (e) {}
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

  // Capture manual user clicks as well so if an order fails, it gets blacklisted too
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

  // Fast single-element toast lookup (0.01ms)
  function findFailureToast() {
    const toast = document.querySelector(".van-toast, .van-popup, [class*='toast']");
    if (!toast || toast.getAttribute("data-arb-seen") === "true") return null;
    const txt = (toast.textContent || "").trim();
    if (!txt) return null;
    if (
      /bought by someone else/i.test(txt) ||
      /someone else/i.test(txt) ||
      /already bought/i.test(txt) ||
      /already taken/i.test(txt) ||
      /no longer available/i.test(txt) ||
      /order.*expired/i.test(txt) ||
      /order.*not exist/i.test(txt) ||
      /order.*invalid/i.test(txt) ||
      /please buy another order/i.test(txt) ||
      /已被他人购买|已被抢|订单已失效/.test(txt)
    ) {
      return { element: toast, text: txt };
    }
    return null;
  }

  // High-performance pure CSS injection for failed orders
  // 0ms ongoing CPU overhead, automatically persists across all Vue re-renders natively!
  let failedStyleEl = null;
  function updateFailedStyles() {
    if (failedOrders.size === 0) return;
    if (!failedStyleEl) {
      failedStyleEl = document.createElement("style");
      failedStyleEl.id = "__arb_failed_styles";
      (document.head || document.documentElement).appendChild(failedStyleEl);
    }
    const selectors = [];
    for (const po of failedOrders) {
      if (po && po.length > 3) {
        selectors.push(`[platformorder="${po}"]`);
      }
    }
    if (selectors.length === 0) return;
    const selStr = selectors.join(", ");
    failedStyleEl.textContent = `
      ${selStr} {
        opacity: 0.6 !important;
      }
      ${selectors.map(s => `${s} button, ${s} .btn, ${s} .x-btn, ${s} .van-button`).join(", ")} {
        opacity: 0.4 !important;
        filter: grayscale(60%) !important;
        pointer-events: none !important;
        cursor: not-allowed !important;
        transition: none !important;
      }
      ${selectors.map(s => `${s} .van-button__text`).join(", ")} {
        visibility: hidden !important;
        position: relative !important;
      }
      ${selectors.map(s => `${s} .van-button__text::after`).join(", ")} {
        content: "Sold Out" !important;
        visibility: visible !important;
        position: absolute !important;
        left: 50% !important;
        top: 0 !important;
        transform: translateX(-50%) !important;
        white-space: nowrap !important;
      }
    `;
  }

  function findPaymentRow(preference = "ANY", customKeyword = "") {
    const bankList = document.querySelector(".bank-list");
    if (!bankList) return null;

    const itemContainers = bankList.querySelectorAll(".item.select");
    const selectedSection = itemContainers[0] || null;
    const anotherSection = itemContainers[1] || null;

    let target = (preference || "ANY").trim().toLowerCase();
    if (target === "custom" && customKeyword) {
      target = customKeyword.trim().toLowerCase();
    }
    if (!target) target = "any";

    function rowMatches(row) {
      if (!row) return false;
      if (
        row.classList.contains("action") ||
        row.classList.contains("disabled") ||
        row.getAttribute("aria-disabled") === "true"
      ) {
        return false;
      }
      if (target === "any") return true;

      const classes = (row.className || "").toLowerCase();
      const text = (row.textContent || "").toLowerCase();

      // Check specific bank aliases
      if (target === "phonepe" && (classes.includes("phonepe") || text.includes("phonepe") || text.includes("@ybl") || text.includes("@ibl") || text.includes("@axl"))) return true;
      if (target === "paytm" && (classes.includes("paytm") || text.includes("paytm") || text.includes("@paytm"))) return true;
      if (target === "supermoney" && (classes.includes("supermoney") || text.includes("supermoney") || text.includes("super.money") || text.includes("@superyes"))) return true;
      if (target === "navi" && (classes.includes("navi") || text.includes("navi") || text.includes("@naviaxis"))) return true;
      if (target === "freecharge" && (classes.includes("freecharge") || text.includes("freecharge"))) return true;
      if (target === "moneyview" && (classes.includes("moneyview") || text.includes("moneyview"))) return true;
      if ((target === "gpay" || target === "googlepay") && (classes.includes("gpay") || text.includes("gpay") || text.includes("google") || text.includes("@okhdfcbank") || text.includes("@okaxis") || text.includes("@oksbi") || text.includes("@okicici"))) return true;
      if (target === "bhim" && (classes.includes("bhim") || text.includes("bhim") || text.includes("@upi"))) return true;
      if (target === "cred" && (classes.includes("cred") || text.includes("cred"))) return true;

      return classes.includes(target) || text.includes(target);
    }

    // Step 1: First check on selected accounts
    if (selectedSection) {
      const selectedRows = [...selectedSection.querySelectorAll(".x-row")];
      const match1 = selectedRows.find(rowMatches);
      if (match1) {
        return {
          element: match1,
          section: "Selected Account",
          text: match1.innerText.replace(/\n+/g, " ").trim()
        };
      }
    }

    // Step 2: Then check in use another account
    if (anotherSection) {
      const anotherRows = [...anotherSection.querySelectorAll(".x-row")];
      const match2 = anotherRows.find(rowMatches);
      if (match2) {
        return {
          element: match2,
          section: "Use Another Account",
          text: match2.innerText.replace(/\n+/g, " ").trim()
        };
      }
    }

    return null;
  }

  function autoSelectPaymentMethod(timeout = 6000) {
    if (settings.autoPayment === false || isPaymentClicked) return Promise.resolve(false);

    const preference = settings.paymentMethod || "ANY";
    const customKeyword = settings.customPayment || "";
    if (preference === "none") return Promise.resolve(false);

    const start = Date.now();
    return new Promise(resolve => {
      const checkIntv = setInterval(() => {
        if (isPaymentClicked) {
          clearInterval(checkIntv);
          return resolve(true);
        }

        const match = findPaymentRow(preference, customKeyword);
        if (match && match.element) {
          clearInterval(checkIntv);
          isPaymentClicked = true;
          log(`AUTO-PAY: Selected [${match.section}] "${match.text}" (target: ${preference}). Clicking...`);
          realClick(match.element);
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
          log(`AUTO-PAY: Timeout waiting for payment method "${preference}"`);
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
    banner.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;background:linear-gradient(135deg,#00e676,#00b848);color:#06190f;padding:12px 24px;border-radius:12px;box-shadow:0 8px 32px rgba(0,230,118,0.5);display:flex;align-items:center;gap:14px;font-family:system-ui,-apple-system,sans-serif;font-weight:700;font-size:15px;";

    const amtStr = amount ? `₹${amount}` : "";
    const textSpan = document.createElement("span");
    textSpan.textContent = `🎉 Order Successfully Bought! ${amtStr}`;

    const stopBtn = document.createElement("button");
    stopBtn.id = "__arb_stop_alarm_btn";
    stopBtn.style.cssText = "background:#06190f;color:#00e676;border:0;padding:6px 14px;border-radius:8px;font-weight:800;font-size:12px;cursor:pointer;";
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
    if (isPurchased) return;

    // Safety guard: if on login page, definitely not an order success
    if (isLoginPage()) {
      log("Login page detected; not a successful order. Stopping bot.");
      stop();
      return;
    }

    // Strict guard: MUST have an active pending order to confirm success
    const activeOrder = pendingOrder || lastAttemptedOrder;
    if (!activeOrder && !orderId) {
      log("Ignored order success: no active order attempt recorded");
      return;
    }

    const finalOrderId = orderId || (activeOrder ? activeOrder.id : "");
    const finalAmount = amount || (activeOrder ? activeOrder.amount : "");

    // Must have a valid order ID or amount
    if (!finalOrderId && !finalAmount) {
      log("Ignored order success: missing order ID and amount");
      return;
    }

    isPurchased = true;
    pendingOrder = null;
    log(`Order ₹${finalAmount || "?"} (${finalOrderId || "?"}) successfully purchased! Turning off buying process.`);
    stop();

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
      autoSelectPaymentMethod();
    }
  }

  function handleOrderFailure(orderId, reason) {
    log(`Order (${orderId || "?"}) failed: "${reason}". Keeping monitoring active...`);
    if (orderId) failedOrders.add(orderId);
    const attempt = pendingOrder || lastAttemptedOrder;
    if (attempt) {
      if (attempt.po) failedOrders.add(attempt.po);
      if (attempt.id) failedOrders.add(attempt.id);
    }
    pendingOrder = null;

    // Apply native CSS rules - 0ms CPU overhead, persistent across Vue re-renders
    updateFailedStyles();

    // Fast refresh to fetch latest orders
    setTimeout(() => {
      if (running && !isPurchased) {
        refreshOrders();
      }
    }, 80);
  }

  function waitForBuyOutcome(attempt) {
    const checkInterval = 50;
    const timeout = 3000;
    const startTime = Date.now();

    const checkTimer = setInterval(() => {
      if (!running || isPurchased || !pendingOrder || pendingOrder.id !== attempt.id) {
        clearInterval(checkTimer);
        return;
      }

      // Check if logged out
      if (isLoginPage()) {
        clearInterval(checkTimer);
        log("Logged out / login page detected while waiting for buy outcome. Marking order failed.");
        handleOrderFailure(attempt.id, "Session expired / Logged out");
        return;
      }

      // 1. Check for failure toast
      const failToast = findFailureToast();
      if (failToast) {
        clearInterval(checkTimer);
        const toastRoot = failToast.element.closest(".van-toast, .van-popup, [class*='toast']") || failToast.element;
        toastRoot.setAttribute("data-arb-seen", "true");
        failToast.element.setAttribute("data-arb-seen", "true");
        handleOrderFailure(attempt.id, failToast.text);
        return;
      }

      // 2. Check if screen navigated to payment / order screen (Success!)
      if (isPaymentOrOrderSuccessPage() || (!isOrderBookPage() && !isLoginPage())) {
        clearInterval(checkTimer);
        handleOrderSuccess(attempt.id, attempt.amount);
        return;
      }

      // 3. Timeout check: still on order book without navigation after timeout
      if (Date.now() - startTime >= timeout) {
        clearInterval(checkTimer);
        log(`Order (${attempt.id}) confirmation timed out on order book. Marking failed and refreshing.`);
        handleOrderFailure(attempt.id, "Timeout - order not confirmed");
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

    let hasAvailable = false;
    for (let i = 0; i < len; i++) {
      const card = cards[i];
      const po = card.getAttribute("platformorder");
      if (po && failedOrders.has(po)) continue;

      const amount = parseAmount(card);
      if (!matches(amount)) continue;

      const orderId = po || getOrderId(card, amount);
      if (failedOrders.has(orderId)) continue;

      hasAvailable = true;

      if (settings.autoBuy) {
        const btn = findBuyButton(card);
        if (!btn || btn.disabled) continue;

        const now = Date.now();
        if (btn._lastClickTime && (now - btn._lastClickTime < 500)) return;
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
    if (document.querySelector(".bank-list") && settings.autoPayment !== false) {
      log("Already on Select Method Payment screen; auto-selecting payment method");
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

      // Check if payment screen appeared
      if (document.querySelector(".bank-list") && settings.autoPayment !== false && !isPaymentClicked) {
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

      // Check if screen changed to payment/order screen strictly WHILE an order attempt is pending
      if (pendingOrder && (isPaymentOrOrderSuccessPage() || !isOrderBookPage())) {
        const orderId = pendingOrder.id;
        const amount = pendingOrder.amount;
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
    // Strictly verify an order attempt is active before confirming success
    if (running && pendingOrder && (isPaymentOrOrderSuccessPage() || !isOrderBookPage())) {
      const orderId = pendingOrder.id;
      const amount = pendingOrder.amount;
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
        if (p.refreshOption) settings.refreshOption = p.refreshOption;
      }
    }
  } catch(e) {}

  window.__arbBuyerMessageListener = messageHandler;
  api.runtime.onMessage.addListener(messageHandler);
})();
