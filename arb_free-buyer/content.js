(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;
  let timer = null;
  let scanTimer = null;
  let running = false;
  let settings = {
    mode: "range",
    min: 100,
    max: 50000,
    fixed: 100,
    latency: 500,
    tab: "OTP-UPI",
    autoRefresh: true,
    autoBuy: true
  };

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
        return (text.startsWith("UPI") || /\bUPI\b/.test(text)) && !text.includes("OTP");
      }
      return text.startsWith(norm) || text.includes(norm);
    });
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

  function clickTargetTab() {
    const targetName = settings.tab || "OTP-UPI";
    const tab = findTargetTab(targetName);
    if (!tab) {
      log(`Target tab "${targetName}" not found`);
      return false;
    }

    const active = tab.getAttribute("aria-selected") === "true" ||
                   tab.classList.contains("van-tab--active");

    log(`Tab "${targetName}" found (active=${active}); refreshing`);
    realClick(tab);

    // Fallback for inner element click if active state didn't toggle
    setTimeout(() => {
      const current = findTargetTab(targetName);
      if (current && current.getAttribute("aria-selected") !== "true") {
        const child = current.querySelector(".tab-title, .van-tab__text, .van-tab__text-ellipsis");
        if (child) {
          realClick(child);
        }
      }
    }, 60);

    return true;
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

  function getOrderCards() {
    const items = [...document.querySelectorAll(".item.mb32, .x-buyList-list .item, [platformorder]")];
    const seenCards = new Set();
    const result = [];
    for (const el of items) {
      const card = el.closest("[platformorder]") || el.closest(".item") || el;
      if (!seenCards.has(card)) {
        seenCards.add(card);
        if (findBuyButton(card)) {
          result.push(card);
        }
      }
    }
    return result;
  }

  function parseAmount(card) {
    const amountNode = card.querySelector(".amount");
    if (amountNode) {
      const text = amountNode.textContent || "";
      const m = text.replace(/,/g, "").match(/([0-9]+(?:\.[0-9]+)?)/);
      if (m) return Number(m[1]);
    }
    const text = card.textContent || "";
    const m = text.replace(/,/g, "").match(/₹\s*([0-9]+(?:\.[0-9]+)?)/);
    if (m) return Number(m[1]);

    const maxAttr = card.getAttribute("maximumamount");
    if (maxAttr && !isNaN(Number(maxAttr))) {
      return Number(maxAttr);
    }
    return NaN;
  }

  function matches(amount) {
    if (!Number.isFinite(amount)) return false;
    if (settings.mode === "fixed") return amount === Number(settings.fixed);
    return amount >= Number(settings.min) && amount <= Number(settings.max);
  }

  function scanOrders() {
    if (!running) return;
    const cards = getOrderCards();
    let matchesFound = 0;

    for (const card of cards) {
      const amount = parseAmount(card);
      if (!matches(amount)) continue;

      matchesFound++;

      if (settings.autoBuy) {
        const clicked = clickBuyButton(card, amount);
        if (clicked) {
          break; // Click first matching order in this tick
        }
      }
    }

    if (matchesFound > 0) {
      log(`Scanned ${cards.length} orders; ${matchesFound} matching`);
    }
  }

  function stop() {
    running = false;
    if (timer) clearInterval(timer);
    if (scanTimer) clearInterval(scanTimer);
    timer = scanTimer = null;
    log("Stopped");
  }

  function start(s) {
    stop();
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

    running = true;
    log(`Started; tab=${settings.tab}; latency=${settings.latency}ms; autoBuy=${settings.autoBuy}`);

    // Scan current DOM immediately
    scanOrders();

    if (running && settings.autoRefresh) {
      // Refresh selected tab immediately, then repeatedly
      clickTargetTab();

      timer = setInterval(() => {
        if (!running) return;
        clickTargetTab();

        setTimeout(() => {
          if (running) scanOrders();
        }, Math.min(250, Math.max(10, Math.floor(settings.latency / 3))));
      }, settings.latency);
    }

    if (running) {
      scanTimer = setInterval(() => {
        if (running) scanOrders();
      }, Math.max(100, Math.min(1000, settings.latency || 100)));
    }
  }

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "START") {
      start(msg);
      if (sendResponse) sendResponse({ ok: true });
    } else if (msg.type === "STOP") {
      stop();
      if (sendResponse) sendResponse({ ok: true });
    } else if (msg.type === "CLICK_TAB") {
      clickTargetTab();
      if (sendResponse) sendResponse({ ok: true });
    } else if (msg.type === "GET_STATUS") {
      if (sendResponse) {
        sendResponse({
          running,
          tab: settings.tab || "OTP-UPI"
        });
      }
    }
  });
})();
