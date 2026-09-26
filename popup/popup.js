/**
 * 3Sus popup logic.
 * - Reads/writes feature settings through the background service worker.
 * - Shows live stats (RAM saved / tabs suspended).
 * - "Suspend All Other Tabs" button.
 * - DOM Cleaner toggle injects/controls content.js in the active tab.
 */

const $ = (id) => document.getElementById(id);

const SETTING_IDS = ["autoSuspend", "blockTrackers", "blockMedia"];
const send = (msg) => chrome.runtime.sendMessage(msg);

/* ------------------------------------------------------------------ */

async function init() {
  const state = await send({ type: "GET_STATE" });

  // Reflect stored settings onto switches.
  SETTING_IDS.forEach((key) => {
    $(key).checked = state.settings[key];
    $(key).addEventListener("change", async (e) => {
      await send({ type: "SET_SETTING", key, value: e.target.checked });
    });
  });

  // DOM cleaner is per-tab and controlled directly here.
  $("domCleaner").checked = state.settings.domCleaner;
  $("domCleaner").addEventListener("change", (e) =>
    toggleDomCleaner(e.target.checked),
  );

  $("tabsSuspended").textContent = state.tabsSuspended;
  $("ramSaved").textContent = state.ramSavedMB;

  $("suspendAll").addEventListener("click", async () => {
    await send({ type: "SUSPEND_ALL" });
    setStatus("All other tabs suspended ✓");
    const fresh = await send({ type: "GET_STATE" });
    $("tabsSuspended").textContent = fresh.tabsSuspended;
    $("ramSaved").textContent = fresh.ramSavedMB;
  });

  $("restoreAll").addEventListener("click", async () => {
    await send({ type: "RESTORE_ALL" });
    setStatus("All tabs restored ✓");
    const fresh = await send({ type: "GET_STATE" });
    $("tabsSuspended").textContent = fresh.tabsSuspended;
    $("ramSaved").textContent = fresh.ramSavedMB;
  });

  // Whitelist control for the current domain.
  await initWhitelist(state.settings.whitelist || []);
}

async function initWhitelist(whitelist) {
  const { domain } = await send({ type: "GET_ACTIVE_TAB" });
  if (!domain) {
    $("wlDomain").textContent = "Not a website";
    $("wlToggle").disabled = true;
    return;
  }
  $("wlDomain").textContent = domain;
  const isOn = whitelist.includes(domain);
  renderWhitelistBtn(isOn);

  $("wlToggle").addEventListener("click", async () => {
    const nowOn = !$("wlToggle").classList.contains("on");
    await send({ type: "TOGGLE_WHITELIST", domain, add: nowOn });
    renderWhitelistBtn(nowOn);
    setStatus(nowOn ? `${domain} whitelisted ✓` : `${domain} removed from whitelist`);
  });
}

function renderWhitelistBtn(on) {
  const btn = $("wlToggle");
  btn.classList.toggle("on", on);
  btn.textContent = on ? "Whitelisted ✓" : "Whitelist";
}

/** Inject (or remove) the DOM cleaner into the active tab. */
async function toggleDomCleaner(on) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || "")) {
    setStatus("Cannot clean this page type");
    $("domCleaner").checked = false;
    return;
  }
  await send({ type: "SET_SETTING", key: "domCleaner", value: on });

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await chrome.tabs.sendMessage(tab.id, {
      type: on ? "CLEAN_ON" : "CLEAN_OFF",
    });
    setStatus(on ? "Page cleaned ✓" : "Cleaning removed");
  } catch (err) {
    setStatus("Page must be reloaded first");
    $("domCleaner").checked = false;
  }
}

function setStatus(text) {
  $("status").textContent = text;
  setTimeout(() => ($("status").textContent = ""), 2500);
}

document.addEventListener("DOMContentLoaded", init);
