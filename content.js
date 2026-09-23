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
    try { el.click(); } catch(e) {}

    const opts = {bubbles: true, cancelable: true, view: window, buttons: 1, button: 0};
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      try {
        el.dispatchEvent(new MouseEvent(type, opts));
      } catch(e) {}
    }

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

  // Single click on the filter toggle button (avoids double-firing)
  function clickFilterButton() {
    const filterBtn = findFilterButton();
    if (!filterBtn) {
      log("Filter button (switch-btn) not found");
      return false;
    }
    filterBtn.click();
    return true;
  }

  // Verify if individual orders list is active (NOT the range page)
  function isIndividualMode() {
    return Boolean(
      document.querySelector(".x-buyList-filter") ||
      document.querySelector(".item[platformorder]") ||
      document.querySelector("[platformorder]")
    );
  }

  // Dynamic order book detector: works across any domain and route without relying on URLs
  function isOrderBookPage() {
    // If "Select Method Payment" or other payment/order screen is visible
    const titleEl = document.querySelector(".van-nav-bar__title, .navbar .title, .van-nav-bar");
    const titleText = (titleEl ? titleEl.textContent : "").trim().toLowerCase();
    if (titleText.includes("select method") || titleText.includes("payment")) {
      return false;
    }

    const hash = (window.location.hash || "").toLowerCase();
    if (hash && (hash.includes("/order/") || hash.includes("/detail") || hash.includes("/payment") || hash.includes("/pay/"))) {
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

  // Checks if orders (either range or individual) have loaded in the DOM
  function areOrdersLoaded() {
    const items = document.querySelectorAll(".item");
    if (items.length === 0) return false;
    const hasLoading = Boolean(
      document.querySelector(".van-loading") ||
      document.querySelector(".van-toast--loading") ||
      document.querySelector('[class*="loadingLottie"]')
    );
    return !hasLoading;
  }

  // Checks if individual orders (with platformorder) are loaded
  function areIndividualOrdersLoaded() {
    return isIndividualMode() && document.querySelectorAll(".item[platformorder]").length > 0;
  }

  // Waits until orders are loaded in DOM before applying filter
  function waitForOrdersLoaded(timeout = 4000) {
    return new Promise(resolve => {
      if (areOrdersLoaded()) return resolve(true);
      const start = Date.now();
      const intv = setInterval(() => {
        if (!running || isPurchased) {
          clearInterval(intv);
          return resolve(false);
        }
        if (areOrdersLoaded()) {
          clearInterval(intv);
          return resolve(true);
        }
        if (Date.now() - start >= timeout) {
          clearInterval(intv);
          resolve(areOrdersLoaded());
        }
      }, 50);
    });
  }

  // Waits until individual order items are loaded in DOM
  function waitForIndividualOrdersLoaded(timeout = 3000) {
    return new Promise(resolve => {
      if (areIndividualOrdersLoaded()) return resolve(true);
      const start = Date.now();
      const intv = setInterval(() => {
        if (!running || isPurchased) {
          clearInterval(intv);
          return resolve(false);
        }
        if (areIndividualOrdersLoaded()) {
          clearInterval(intv);
          return resolve(true);
        }
        if (Date.now() - start >= timeout) {
          clearInterval(intv);
          resolve(areIndividualOrdersLoaded());
        }
      }, 50);
    });
  }

  let isRefreshing = false;

  // Refresh orders by clicking the filter icon - only when order is loaded!
  async function refreshOrders() {
    if (!running || isPurchased || isRefreshing || pendingOrder) return;
    if (!isOrderBookPage()) return;

    // Apply filter only when the order is loaded
    if (!areOrdersLoaded()) return;

    isRefreshing = true;
    clickFilterButton();

    // Wait until new orders are loaded after clicking filter
    await waitForOrdersLoaded(2000);
    isRefreshing = false;

    if (running && !isPurchased) {
      scanOrders();
    }
  }

  function findBuyButton(card) {
    if (!card) return null;
    const buttons = [...card.querySelectorAll("button, .btn, .x-btn, .van-button")];
    const buyBtn = buttons.find(b => /buy/i.test(b.textContent || ""));
    if (buyBtn) return buyBtn;
    return card.querySelector(".van-button--primary, .x-btn, .btn") || card.querySelector("button") || null;
  }

  function clickBuyButton(card, amount) {
    const btn = findBuyButton(card);
    if (!btn) return false;

    const disabled = btn.disabled ||
                     btn.classList.contains("van-button--disabled") ||
                     btn.classList.contains("van-button--loading") ||
                     btn.getAttribute("aria-disabled") === "true";
    if (disabled) return false;

    // Prevent double-clicking the exact same DOM element in rapid succession (< 500ms)
    const now = Date.now();
    if (btn._lastClickTime && (now - btn._lastClickTime < 500)) {
      return false;
    }
    btn._lastClickTime = now;

    const po = card.getAttribute("platformorder") || "";
    log(`AUTO-BUY: Clicked Buy for ₹${amount || "?"} order=${po}`);

    realClick(btn);

    const child = btn.querySelector(".van-button__text, .van-button__content");
    if (child) {
      realClick(child);
    }
    return true;
  }

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

  // Only return individual order cards (strictly ignores range cards)
  function getOrderCards() {
    if (!isIndividualMode()) return [];

    const items = [...document.querySelectorAll(".item[platformorder], [platformorder]")];
    const seenCards = new Set();
    const result = [];
    for (const el of items) {
      const card = el.closest("[platformorder]") || el;
      if (!seenCards.has(card)) {
        seenCards.add(card);
        if (card.getAttribute("data-arb-failed") === "true") {
          continue;
        }
        const po = card.getAttribute("platformorder");
        if (po && failedOrders.has(po)) {
          continue;
        }
        const cardId = getOrderId(card);
        if (cardId && failedOrders.has(cardId)) {
          continue;
        }
        if (findBuyButton(card)) {
          result.push(card);
        }
      }
    }
    return result;
  }

  function parseAmount(card) {
    if (!card) return NaN;

    // Direct attribute on individual order item
    const maxAttr = card.getAttribute("maximumamount");
    if (maxAttr && !isNaN(Number(maxAttr))) {
      return Number(maxAttr);
    }

    const amountNode = card.querySelector(".amount, [class*='amount'], [class*='price']");
    if (amountNode) {
      const text = amountNode.textContent || "";
      const m = text.replace(/,/g, "").match(/([0-9]+(?:\\.[0-9]+)?)/);
      if (m) return Number(m[1]);
    }

    // Ignore range text (e.g., "100 - 200") unless explicitly an individual order
    const text = card.textContent || "";
    if (/\\d+\\s*-\\s*\\d+/.test(text) && !card.getAttribute("platformorder")) {
      return NaN;
    }

    const m = text.replace(/,/g, "").match(/₹\\s*([0-9]+(?:\\.[0-9]+)?)/);
    if (m) return Number(m[1]);

    return NaN;
  }

  function matches(amount) {
    if (!Number.isFinite(amount)) return false;
    if (settings.mode === "fixed") return amount === Number(settings.fixed);
    return amount >= Number(settings.min) && amount <= Number(settings.max);
  }

  function findFailureToast() {
    const toasts = document.querySelectorAll(".van-toast, .van-popup, [class*='toast']");
    for (const t of toasts) {
      if (t.getAttribute("data-arb-dismissed") === "true") continue;
      const txt = (t.textContent || "").trim();
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
        /已被他人购买|已被抢|订单已失效/.test(txt)
      ) {
        return { element: t, text: txt };
      }
    }
    return null;
  }

  function dismissFailureToasts() {
    const toasts = document.querySelectorAll(".van-toast, .van-popup, [class*='toast']");
    for (const t of toasts) {
      const txt = (t.textContent || "").trim();
      if (
        /bought by someone else/i.test(txt) ||
        /someone else/i.test(txt) ||
        /already bought/i.test(txt) ||
        /already taken/i.test(txt) ||
        /no longer available/i.test(txt) ||
        /order.*expired/i.test(txt) ||
        /order.*not exist/i.test(txt) ||
        /order.*invalid/i.test(txt)
      ) {
        t.setAttribute("data-arb-dismissed", "true");
        try {
          t.remove();
        } catch (e) {
          t.style.display = "none";
        }
      }
    }
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

  function handleOrderSuccess(orderId, amount) {
    if (isPurchased) return;
    isPurchased = true;
    pendingOrder = null;
    log(`Order ₹${amount || "?"} (${orderId || "?"}) successfully purchased! Turning off buying process.`);
    stop();
    try {
      api.runtime.sendMessage({
        type: "ORDER_PURCHASED",
        amount,
        order: orderId
      });
    } catch (e) {}

    // Auto-select payment method on order success
    if (settings.autoPayment !== false) {
      autoSelectPaymentMethod();
    }
  }

  function handleOrderFailure(orderId, reason) {
    if (!running || isPurchased) return;
    log(`Order (${orderId || "?"}) failed: "${reason}". Keeping monitoring active...`);
    if (orderId) {
      failedOrders.add(orderId);
    }
    if (pendingOrder && pendingOrder.card) {
      try {
        pendingOrder.card.setAttribute("data-arb-failed", "true");
        const btn = findBuyButton(pendingOrder.card);
        if (btn) {
          btn.disabled = true;
          btn.classList.add("van-button--disabled");
          btn.style.pointerEvents = "none";
          btn.style.opacity = "0.4";
          const btnText = btn.querySelector(".van-button__text, .van-button__content") || btn;
          if (btnText) btnText.textContent = "Sold Out";
        }
      } catch (e) {}
    }
    pendingOrder = null;
    dismissFailureToasts();

    // Immediately trigger order list refresh to clear already-bought order
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

      // 1. Check for failure toast
      const failToast = findFailureToast();
      if (failToast) {
        clearInterval(checkTimer);
        handleOrderFailure(attempt.id, failToast.text);
        return;
      }

      // 2. Check if screen navigated away from order book (Success!)
      if (!isOrderBookPage()) {
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

  // Scan only individual orders - zero operations on the range page
  function scanOrders() {
    if (!running || isPurchased || pendingOrder) return;
    if (!isOrderBookPage()) return;

    // Do nothing on range page
    if (!isIndividualMode()) return;

    const cards = getOrderCards();
    if (cards.length === 0) return; // Only process when orders are loaded
    let matchesFound = 0;

    for (const card of cards) {
      const amount = parseAmount(card);
      if (!matches(amount)) continue;

      const orderId = getOrderId(card, amount);
      if (failedOrders.has(orderId)) continue;

      matchesFound++;

      if (settings.autoBuy) {
        const clicked = clickBuyButton(card, amount);
        if (clicked) {
          pendingOrder = {
            id: orderId,
            amount: amount,
            card: card,
            timestamp: Date.now()
          };
          log(`AUTO-BUY: Attempting order ₹${amount} (${orderId}), awaiting confirmation...`);
          waitForBuyOutcome(pendingOrder);
          return; // Await outcome of this order before attempting another
        }
      }
    }

    if (matchesFound > 0) {
      log(`Scanned ${cards.length} individual orders; ${matchesFound} matching`);
    }
  }

  let observer = null;

  function stop() {
    running = false;
    pendingOrder = null;
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
    isPurchased = false;
    isPaymentClicked = false;
    pendingOrder = null;
    failedOrders.clear();
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
      // Check if payment screen appeared
      if (document.querySelector(".bank-list") && settings.autoPayment !== false && !isPaymentClicked) {
        autoSelectPaymentMethod();
      }

      if (!running || isPurchased) return;

      // Check if failure toast appeared
      const failToast = findFailureToast();
      if (failToast && pendingOrder) {
        handleOrderFailure(pendingOrder.id, failToast.text);
        return;
      }

      // Check if screen changed away from order book (e.g. payment screen reached)
      if (!isOrderBookPage()) {
        const orderId = pendingOrder ? pendingOrder.id : "";
        const amount = pendingOrder ? pendingOrder.amount : "";
        handleOrderSuccess(orderId, amount);
      }
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    // If needed, switch tab ONCE at start (never continuously in refresh loop!)
    const switchedTab = ensureTargetTab();

    // Apply select filter only when the order is loaded
    (async () => {
      if (switchedTab) {
        await new Promise(r => setTimeout(r, 200));
      }
      // Wait until orders are loaded in DOM before applying filter
      await waitForOrdersLoaded();
      if (!running || isPurchased) return;

      if (!isIndividualMode()) {
        log("Order loaded; applying filter to switch to individual orders");
        clickFilterButton();
        await waitForIndividualOrdersLoaded();
      }

      if (running && !isPurchased) {
        scanOrders();
      }
    })();

    // Auto-refresh: clicks filter icon repeatedly to refresh individual orders (never clicks OTP-UPI tab)
    if (settings.autoRefresh) {
      const refreshInterval = Math.max(200, settings.latency);
      timer = setInterval(() => {
        if (!running) return;
        refreshOrders();

        setTimeout(() => {
          if (running) scanOrders();
        }, 150);
      }, refreshInterval);
    }

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
      const res = {
        running,
        tab: settings.tab || "OTP-UPI",
        paymentMethod: settings.paymentMethod || "ANY"
      };
      if (sendResponse) sendResponse(res);
      return Promise.resolve(res);
    }
  };

  function checkNavigation() {
    if (running && !isOrderBookPage()) {
      const orderId = pendingOrder ? pendingOrder.id : "";
      const amount = pendingOrder ? pendingOrder.amount : "";
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

  window.__arbBuyerMessageListener = messageHandler;
  api.runtime.onMessage.addListener(messageHandler);
})();
