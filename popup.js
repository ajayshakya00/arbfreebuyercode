const api = typeof browser !== "undefined" ? browser : chrome;

const $ = id => document.getElementById(id);
let mode = "range";
let isRunning = false;

// Segmented mode toggle
$("fixedBtn").onclick = () => {
  mode = "fixed";
  $("fixedBtn").classList.add("active");
  $("rangeBtn").classList.remove("active");
  $("fixedBox").style.display = "";
  $("rangeBox").style.display = "none";
};

$("rangeBtn").onclick = () => {
  mode = "range";
  $("rangeBtn").classList.add("active");
  $("fixedBtn").classList.remove("active");
  $("fixedBox").style.display = "none";
  $("rangeBox").style.display = "";
};

function clampSettings() {
  let latency = Math.max(200, Number($("latency").value) || 500);
  let min = Math.max(100, Math.min(50000, Number($("min").value) || 100));
  let max = Math.max(100, Math.min(50000, Number($("max").value) || 50000));
  let fixed = Math.max(100, Math.min(50000, Number($("fixed").value) || 100));
  let tab = $("tabSelect").value || "OTP-UPI";
  if (max < min) [min, max] = [max, min];
  $("latency").value = latency;
  $("min").value = min;
  $("max").value = max;
  $("fixed").value = fixed;
  return {latency, min, max, fixed, tab};
}

async function getActivePayjoraTab() {
  const tabs = await api.tabs.query({active: true, currentWindow: true});
  return tabs.find(t => /^https:\/\/uidif\.payjora\.com\//.test(t.url || ""));
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
    btn.textContent = "▶ Start Monitoring";
    btn.className = "btn-toggle btn-start";
    badge.textContent = "● IDLE";
    badge.className = "badge badge-idle";
  }
}

async function handleToggle() {
  const tab = await getActivePayjoraTab();
  if (!tab) {
    const badge = $("statusBadge");
    badge.textContent = "Payjora tab not open";
    badge.className = "badge badge-idle";
    return;
  }

  if (isRunning) {
    // Send STOP
    await api.tabs.sendMessage(tab.id, { type: "STOP" });
    updateUiState(false);
  } else {
    // Send START
    const s = clampSettings();
    await api.tabs.sendMessage(tab.id, {
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
}

$("toggleBtn").onclick = handleToggle;

// GitHub source link handler
$("sourceLink").onclick = (e) => {
  e.preventDefault();
  api.tabs.create({ url: "https://github.com/ajayshakya00/arbfreebuyercode" });
};

// Initialize settings from storage and query live page status
(async () => {
  const s = await api.storage.local.get(["mode", "min", "max", "fixed", "latency", "refresh", "autoBuy", "tab"]);
  mode = s.mode || "range";
  $("min").value = s.min ?? 100;
  $("max").value = s.max ?? 50000;
  $("fixed").value = s.fixed ?? 100;
  $("latency").value = Math.max(200, s.latency ?? 500);
  $("refresh").checked = s.refresh !== false;
  $("autoBuy").checked = s.autoBuy !== false;
  if (s.tab) $("tabSelect").value = s.tab;

  if (mode === "fixed") $("fixedBtn").click(); else $("rangeBtn").click();

  try {
    const tab = await getActivePayjoraTab();
    if (tab) {
      api.tabs.sendMessage(tab.id, { type: "GET_STATUS" }, (res) => {
        if (api.runtime.lastError) return;
        if (res && typeof res.running === "boolean") {
          updateUiState(res.running, res.tab);
        }
      });
    }
  } catch (e) {}
})();

// Persist settings on popup close
window.addEventListener("beforeunload", async () => {
  const s = clampSettings();
  await api.storage.local.set({
    mode,
    min: s.min,
    max: s.max,
    fixed: s.fixed,
    latency: s.latency,
    tab: s.tab,
    refresh: $("refresh").checked,
    autoBuy: $("autoBuy").checked
  });
});
