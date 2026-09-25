const api = typeof browser !== "undefined" ? browser : chrome;

const $ = id => document.getElementById(id);
let mode = "range";
let isRunning = false;
let customAudioData = null;
let customAudioFileName = "";
let testAudio = null;

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
    autoBuy: $("autoBuy").checked,
    autoPayment: $("autoPayment").checked,
    soundAlarm: $("soundAlarm").checked,
    customAudioData: customAudioData || null,
    customAudioFileName: customAudioFileName || "",
    refreshOption: $("refreshOption").value || "Large",
    paymentMethod: $("paymentMethod").value,
    customPayment: $("customPayment").value
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
      const extStored = await api.storage.local.get([
        "mode", "min", "max", "fixed", "latency", "refresh", "autoBuy",
        "autoPayment", "soundAlarm", "customAudioData", "customAudioFileName",
        "refreshOption", "paymentMethod", "customPayment", "tab"
      ]);
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

  if (tab.url && /login|signin/i.test(tab.url)) {
    const badge = $("statusBadge");
    badge.textContent = "Please log in first";
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
        autoBuy: $("autoBuy").checked,
        autoPayment: $("autoPayment").checked,
        soundAlarm: $("soundAlarm").checked,
        customAudioData: customAudioData || null,
        refreshOption: $("refreshOption").value || "Large",
        paymentMethod: $("paymentMethod").value,
        customPayment: $("customPayment").value
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

function updatePaymentUi() {
  const isAutoPay = $("autoPayment").checked;
  const method = $("paymentMethod").value;
  $("paymentMethodWrap").style.display = isAutoPay ? "" : "none";
  $("customPaymentBox").style.display = (isAutoPay && method === "custom") ? "" : "none";
}

function updateAudioUi() {
  if (customAudioFileName) {
    $("customAudioInfo").style.display = "flex";
    $("customAudioName").textContent = `🎵 ${customAudioFileName}`;
  } else {
    $("customAudioInfo").style.display = "none";
    $("customAudioName").textContent = "";
  }
}

// Test Alarm Button Handler
$("testAlarmBtn").onclick = () => {
  if (testAudio) {
    try { testAudio.pause(); } catch(e) {}
    testAudio = null;
    $("testAlarmBtn").textContent = "🔔 Test Alarm";
    return;
  }

  const audioSrc = customAudioData || (api && api.runtime ? api.runtime.getURL("alarm.mp3") : "alarm.mp3");
  testAudio = new Audio(audioSrc);
  testAudio.play().then(() => {
    $("testAlarmBtn").textContent = "⏹ Stop Test";
  }).catch(() => {
    playSynthBeep();
    $("testAlarmBtn").textContent = "🔔 Beeped!";
    setTimeout(() => { $("testAlarmBtn").textContent = "🔔 Test Alarm"; }, 1500);
  });
  testAudio.onended = () => {
    testAudio = null;
    $("testAlarmBtn").textContent = "🔔 Test Alarm";
  };
};

function playSynthBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1174, 1396, 1760].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.12);
      gain.gain.setValueAtTime(0.3, ctx.currentTime + idx * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.12 + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + idx * 0.12);
      osc.stop(ctx.currentTime + idx * 0.12 + 0.22);
    });
  } catch (e) {}
}

// Attach Custom Audio Handler
$("customAudioInput").onchange = (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    alert("Audio file too large. Max size is 8MB.");
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    customAudioData = ev.target.result;
    customAudioFileName = file.name;
    updateAudioUi();
    savePreferences(true);
  };
  reader.readAsDataURL(file);
};

$("removeCustomAudio").onclick = () => {
  customAudioData = null;
  customAudioFileName = "";
  $("customAudioInput").value = "";
  updateAudioUi();
  savePreferences(true);
};

$("autoPayment").addEventListener("change", () => {
  updatePaymentUi();
  savePreferences(true);
});

$("paymentMethod").addEventListener("change", () => {
  updatePaymentUi();
  savePreferences(true);
});

$("customPayment").addEventListener("input", () => savePreferences(false));
$("customPayment").addEventListener("change", () => savePreferences(true));
$("customPayment").addEventListener("blur", () => savePreferences(true));

// GitHub source link handler
$("sourceLink").onclick = (e) => {
  e.preventDefault();
  api.tabs.create({ url: "https://github.com/ajayshakya00/arbfreebuyercode" });
};

// Bind change, input, and blur listeners to auto-save preferences
["min", "max", "fixed", "latency"].forEach(id => {
  $(id).addEventListener("input", () => savePreferences(false));
  $(id).addEventListener("change", () => savePreferences(true));
  $(id).addEventListener("blur", () => savePreferences(true));
});
["tabSelect", "refresh", "autoBuy", "soundAlarm", "refreshOption"].forEach(id => {
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
  $("autoPayment").checked = s.autoPayment !== false;
  $("soundAlarm").checked = s.soundAlarm !== false;
  $("refreshOption").value = s.refreshOption || "Large";
  customAudioData = s.customAudioData || null;
  customAudioFileName = s.customAudioFileName || "";
  $("paymentMethod").value = s.paymentMethod || "ANY";
  $("customPayment").value = s.customPayment || "";
  if (s.tab) $("tabSelect").value = s.tab;

  clampSettings(true);
  updatePaymentUi();
  updateAudioUi();

  if (mode === "fixed") {
    $("fixedBtn").click();
  } else {
    $("rangeBtn").click();
  }

  try {
    const tab = await getActiveTab();
    if (tab && tab.id && tab.url && /^https?:\/\//i.test(tab.url)) {
      const res = await sendTabMessage(tab.id, { type: "GET_STATUS" });
      if (res) {
        if (res.isLoginPage) {
          const badge = $("statusBadge");
          badge.textContent = "Please log in";
          badge.className = "badge badge-idle";
        } else if (typeof res.running === "boolean") {
          updateUiState(res.running, res.tab);
        }
        if (!res.running && res.activeOnPage && !s.tab) {
          $("tabSelect").value = res.activeOnPage;
        }
      }
    }
  } catch (e) {}
})();

// Listen for real-time status updates (e.g. order purchased -> turn off monitoring)
if (api && api.runtime && api.runtime.onMessage) {
  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "ORDER_PURCHASED") {
      updateUiState(false);
    } else if (msg && msg.type === "PAYMENT_METHOD_CLICKED") {
      const badge = $("statusBadge");
      badge.textContent = `PAID (${msg.method || "OK"})`;
      badge.className = "badge badge-running";
    }
  });
}

// Persist settings on popup close as safety net
window.addEventListener("beforeunload", () => savePreferences(true));

