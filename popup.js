const api = typeof browser !== "undefined" ? browser : chrome;

const $ = id => document.getElementById(id);
let mode = "range";
let isRunning = false;

function clampSettings(updateUi = true) {
  let rawLatency = Number($("latency").value);
  let latency = isNaN(rawLatency) ? 500 : Math.max(0, rawLatency);

  let rawFixed = Number($("fixed").value);
  let fixed = isNaN(rawFixed) ? 100 : Math.max(0, rawFixed);

  let rawMin = Number($("min").value);
  let rawMax = Number($("max").value);

  let min = isNaN(rawMin) ? 0 : Math.max(0, rawMin);
  let max = isNaN(rawMax) ? Math.max(min + 1, 50000) : Math.max(0, rawMax);

  // In range section, always enforce min < max
  if (min >= max) {
    if (min > max) {
      [min, max] = [max, min];
    } else {
      max = min + 1;
    }
  }

  if (updateUi) {
    $("latency").value = latency;
    $("min").value = min;
    $("max").value = max;
    $("fixed").value = fixed;
  }

  let tab = $("tabSelect").value || "OTP-UPI";
  return {latency, min, max, fixed, tab};
}

// Save user preferences directly to localStorage
function savePreferences(updateUi = false) {
  const s = clampSettings(updateUi);
  const prefs = {
    mode,
    min: s.min,
    max: s.max,
    fixed: s.fixed,
    latency: s.latency,
    tab: s.tab,
    refresh: $("refresh").checked,
    autoBuy: $("autoBuy").checked
  };

  try {
    localStorage.setItem("arb_preferences", JSON.stringify(prefs));
  } catch (e) {
    console.warn("localStorage save error:", e);
  }

  // Also sync to browser.storage.local for compatibility
  try {
    if (api && api.storage && api.storage.local) {
      api.storage.local.set(prefs);
    }
  } catch (e) {}
}

// Load user preferences from localStorage with extension storage fallback
async function loadPreferences() {
  let prefs = null;
  try {
    const raw = localStorage.getItem("arb_preferences");
    if (raw) {
      prefs = JSON.parse(raw);
    }
  } catch (e) {
    console.warn("localStorage read error:", e);
  }

  if (!prefs && api && api.storage && api.storage.local) {
    try {
      const extStored = await api.storage.local.get(["mode", "min", "max", "fixed", "latency", "refresh", "autoBuy", "tab"]);
      if (extStored && Object.keys(extStored).length > 0) {
        prefs = extStored;
      }
    } catch (e) {}
  }

  return prefs || {};
}

// Segmented mode toggle
$("fixedBtn").onclick = () => {
  mode = "fixed";
  $("fixedBtn").classList.add("active");
  $("rangeBtn").classList.remove("active");
  $("fixedBox").style.display = "";
  $("rangeBox").style.display = "none";
  savePreferences(true);
};

$("rangeBtn").onclick = () => {
  mode = "range";
  $("rangeBtn").classList.add("active");
  $("fixedBtn").classList.remove("active");
  $("fixedBox").style.display = "none";
  $("rangeBox").style.display = "";
  savePreferences(true);
};

async function getActiveTab() {
  const extApi = typeof browser !== "undefined" ? browser : chrome;
  try {
    const tabs = await extApi.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs && tabs[0]) return tabs[0];
  } catch (e) {}

  try {
    const tabs = await extApi.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0]) return tabs[0];
  } catch (e) {}

  try {
    const tabs = await extApi.tabs.query({ active: true });
    if (tabs && tabs[0]) return tabs[0];
  } catch (e) {}

  return null;
}

async function sendTabMessage(tabId, message) {
  const isFirefox = typeof browser !== "undefined" && Boolean(browser.tabs);

  const doSend = () => {
    if (isFirefox) {
      return browser.tabs.sendMessage(tabId, message);
    }
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
  };

  const doInject = async () => {
    const extApi = typeof browser !== "undefined" ? browser : chrome;
    if (extApi && extApi.scripting && extApi.scripting.executeScript) {
      return extApi.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });
    }
  };

  try {
    return await doSend();
  } catch (err) {
    // Content script not yet present in tab; auto-inject and retry
    console.log("Auto-injecting content.js into tab " + tabId);
    try {
      await doInject();
      await new Promise(r => setTimeout(r, 120));
      return await doSend();
    } catch (injectErr) {
      console.error("Auto-inject failed:", injectErr);
      throw injectErr;
    }
  }
}

function updateUiState(running, tabName) {
  isRunning = running;
  const btn = $("toggleBtn");
  const badge = $("statusBadge");

  if (running) {
    btn.textContent = "■ Stop Monitoring";
    btn.className = "btn-toggle btn-stop";
    badge.textContent = `● LIVE (${tabName || $("tabSelect").value || "OTP-UPI"})`;
    badge.className = "badge badge-running";
  } else {
    btn.textContent = "▶ Start Buying";
    btn.className = "btn-toggle btn-start";
    badge.textContent = "● IDLE";
    badge.className = "badge badge-idle";
  }
}

async function handleToggle() {
  savePreferences(true);
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    const badge = $("statusBadge");
    badge.textContent = "No active tab";
    badge.className = "badge badge-idle";
    return;
  }

  if (tab.url && !/^https?:\/\//i.test(tab.url)) {
    const badge = $("statusBadge");
    badge.textContent = "Open website first";
    badge.className = "badge badge-idle";
    return;
  }

  try {
    if (isRunning) {
      // Send STOP
      await sendTabMessage(tab.id, { type: "STOP" });
      updateUiState(false);
    } else {
      // Send START
      const s = clampSettings(true);
      await sendTabMessage(tab.id, {
        type: "START",
        mode,
        min: s.min,
        max: s.max,
        fixed: s.fixed,
        latency: s.latency,
        tab: s.tab,
        autoRefresh: $("refresh").checked,
        autoBuy: $("autoBuy").checked
      });
      updateUiState(true, s.tab);
    }
  } catch (err) {
    console.error("Failed to communicate with tab:", err);
    const badge = $("statusBadge");
    badge.textContent = err.message ? err.message.slice(0, 20) : "Cannot connect";
    badge.className = "badge badge-idle";
  }
}

$("toggleBtn").onclick = handleToggle;

// GitHub source link handler
$("sourceLink").onclick = (e) => {
  e.preventDefault();
  api.tabs.create({ url: "https://github.com/ajayshakya00/arbfreebuyercode" });
};

// Bind change, input, and blur listeners to auto-save preferences
// On input: save without re-formatting inputs to preserve smooth cursor typing
["min", "max", "fixed", "latency"].forEach(id => {
  $(id).addEventListener("input", () => savePreferences(false));
  $(id).addEventListener("change", () => savePreferences(true));
  $(id).addEventListener("blur", () => savePreferences(true));
});
["tabSelect", "refresh", "autoBuy"].forEach(id => {
  $(id).addEventListener("change", () => savePreferences(true));
});

// Initialize settings from localStorage and query live page status
(async () => {
  const s = await loadPreferences();
  mode = s.mode || "range";
  $("min").value = s.min !== undefined && !isNaN(Number(s.min)) ? Number(s.min) : 100;
  $("max").value = s.max !== undefined && !isNaN(Number(s.max)) ? Number(s.max) : 50000;
  $("fixed").value = s.fixed !== undefined && !isNaN(Number(s.fixed)) ? Number(s.fixed) : 100;
  $("latency").value = s.latency !== undefined && !isNaN(Number(s.latency)) ? Math.max(0, Number(s.latency)) : 500;
  $("refresh").checked = s.refresh !== false;
  $("autoBuy").checked = s.autoBuy !== false;
  if (s.tab) $("tabSelect").value = s.tab;

  clampSettings(true);

  if (mode === "fixed") {
    $("fixedBtn").click();
  } else {
    $("rangeBtn").click();
  }

  try {
    const tab = await getActiveTab();
    if (tab && tab.id && tab.url && /^https?:\/\//i.test(tab.url)) {
      const res = await sendTabMessage(tab.id, { type: "GET_STATUS" });
      if (res && typeof res.running === "boolean") {
        updateUiState(res.running, res.tab);
      }
    }
  } catch (e) {}
})();

// Listen for real-time status updates (e.g. order purchased -> turn off monitoring)
if (api && api.runtime && api.runtime.onMessage) {
  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "ORDER_PURCHASED") {
      updateUiState(false);
    }
  });
}

// Persist settings on popup close as safety net
window.addEventListener("beforeunload", () => savePreferences(true));

