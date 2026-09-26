/**
 * 3Sus — background service worker (MV3).
 * Responsibilities:
 *  1. Track tab activity and suspend tabs inactive > 5 minutes.
 *  2. Never suspend tabs playing audio or pinned tabs.
 *  3. Never suspend whitelisted domains (managed from the popup).
 *  4. Toggle declarativeNetRequest blocklists (trackers / ads / autoplay media).
 *  5. Maintain stats (tabs suspended, estimated RAM saved) in chrome.storage.
 */

const SUSPEND_AFTER_MS = 5 * 60 * 1000; // 5 minutes of inactivity (strict)
const EST_RAM_PER_TAB_MB = 80; // Conservative average per background tab
const RAM_SAVED_KEY = "ramSavedMB";
const SUSPENDED_KEY = "tabsSuspended";

// Per-tab inactivity bookkeeping (kept in SW memory; rebuilt on wake)
const lastActive = new Map(); // tabId -> epoch ms of last activity
const originalUrl = new Map(); // tabId -> URL before suspension

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return Object.assign(
    {
      autoSuspend: true,
      blockTrackers: true,
      blockMedia: false,
      domCleaner: false,
      whitelist: [],
    },
    settings || {},
  );
}

async function bumpStat(key, value = 1) {
  const cur = (await chrome.storage.local.get(key))[key] || 0;
  await chrome.storage.local.set({ [key]: cur + value });
}

/** Is this tab's domain on the user's suspension whitelist? */
function isWhitelisted(url, whitelist) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return whitelist.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

/** Suspend a tab: store its URL, then swap in the lightweight placeholder. */
async function suspendTab(tabId, settings = null, ignoreAudible = false) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (
      !tab ||
      !tab.url ||
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chrome-extension://") ||
      tab.pinned || // Smart exclusion: pinned tabs are never suspended
      (!ignoreAudible && tab.audible === true) // Smart exclusion: audio tabs
    )
      return;
    if (tab.url.includes("suspended.html")) return; // already suspended

    settings = settings || (await getSettings());
    if (isWhitelisted(tab.url, settings.whitelist)) return;

    originalUrl.set(tabId, tab.url);
    await chrome.storage.local.set({ [`restore_${tabId}`]: tab.url });

    const suspendUrl =
      chrome.runtime.getURL("suspended.html") +
      "?tab=" +
      tabId +
      "&ram=" +
      EST_RAM_PER_TAB_MB;

    await chrome.tabs.update(tabId, { url: suspendUrl });
    lastActive.delete(tabId);

    await bumpStat(SUSPENDED_KEY);
    await bumpStat(RAM_SAVED_KEY, EST_RAM_PER_TAB_MB);
  } catch (e) {
    // Tab probably closed — ignore.
  }
}

/** Suspend every tab except the currently active one. */
async function suspendAllOthers() {
  const tabs = await chrome.tabs.query({ active: false, windowType: "normal" });
  for (const t of tabs) await suspendTab(t.id);
}

/** Restore every suspended tab to its original URL. */
async function restoreAllTabs() {
  const tabs = await chrome.tabs.query({ windowType: "normal" });
  for (const t of tabs) {
    const key = `restore_${t.id}`;
    const data = await chrome.storage.local.get(key);
    const url = data[key];
    if (url) {
      await chrome.tabs.update(t.id, { url });
      await chrome.storage.local.remove(key);
      // Net RAM effect: this tab is active again.
      const cur =
        (await chrome.storage.local.get(RAM_SAVED_KEY))[RAM_SAVED_KEY] || 0;
      await chrome.storage.local.set({
        [RAM_SAVED_KEY]: Math.max(0, cur - EST_RAM_PER_TAB_MB),
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tab activity monitoring                                             */
/* ------------------------------------------------------------------ */

function touch(tabId) {
  lastActive.set(tabId, Date.now());
}

chrome.tabs.onActivated.addListener(({ tabId }) => touch(tabId));

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // A user-facing navigation means the tab is being used.
  if (info.status === "loading" && !tab.url?.includes("suspended.html"))
    touch(tabId);
  // Clean up state for closed/refreshed tabs.
  if (info.url === undefined && info.status === "loading") {
    chrome.storage.local.remove(`restore_${tabId}`);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastActive.delete(tabId);
  originalUrl.delete(tabId);
  chrome.storage.local.remove(`restore_${tabId}`);
});

// Heartbeat alarm: check timers every minute (SW-safe, survives worker sleep)
chrome.alarms?.create("suspendCheck", { periodInMinutes: 1 });
chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create("suspendCheck", { periodInMinutes: 1 });
  // Sync DNR rules to default settings on install.
  await syncDnrRules(await getSettings());
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "suspendCheck") return;
  const { autoSuspend } = await getSettings();
  if (!autoSuspend) return;
  const now = Date.now();
  for (const [tabId, ts] of lastActive) {
    if (now - ts >= SUSPEND_AFTER_MS) await suspendTab(tabId);
  }
});

/* ------------------------------------------------------------------ */
/* DeclarativeNetRequest blocklists (dynamic, toggled from popup)      */
/* ------------------------------------------------------------------ */

// Tracker/ad domains blocked when "blockTrackers" is ON.
const TRACKER_DOMAINS = [
  "||google-analytics.com^",
  "||googletagmanager.com^",
  "||doubleclick.net^",
  "||facebook.net^",
  "||connect.facebook.com^",
  "||scorecardresearch.com^",
  "||hotjar.com^",
  "||mixpanel.com^",
  "||segment.io^",
  "||criteo.com^",
  "||taboola.com^",
  "||outbrain.com^",
  "||quantserve.com^",
  "||adnxs.com^",
  "||adsrvr.org^",
  "||amazon-adsystem.com^",
];

// Ad-network catch-alls blocked alongside trackers.
const AD_DOMAINS = [
  "||googlesyndication.com^",
  "||googleadservices.com^",
  "||adsensecustomsearchads.com^",
];

function buildRules(settings) {
  const rules = [];

  if (settings.blockTrackers) {
    // One dynamic rule per blocked domain.
    TRACKER_DOMAINS.forEach((f, i) => {
      rules.push({
        id: 100 + i,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: f,
          resourceTypes: ["script", "image", "xmlhttprequest", "sub_frame"],
        },
      });
    });
    AD_DOMAINS.forEach((f, i) => {
      rules.push({
        id: 200 + i,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: f,
          resourceTypes: ["script", "sub_frame", "image"],
        },
      });
    });
  }

  if (settings.blockMedia) {
    // Block auto-playing video/audio media requests.
    rules.push({
      id: 300,
      priority: 1,
      action: { type: "block" },
      condition: { resourceTypes: ["media"] },
    });
  }

  return rules;
}

async function syncDnrRules(settings) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: buildRules(settings),
  });
}

/* ------------------------------------------------------------------ */
/* Messages from popup / suspended page                                */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "GET_STATE": {
        const settings = await getSettings();
        const stats = await chrome.storage.local.get([
          SUSPENDED_KEY,
          RAM_SAVED_KEY,
        ]);
        sendResponse({
          settings,
          tabsSuspended: stats[SUSPENDED_KEY] || 0,
          ramSavedMB: stats[RAM_SAVED_KEY] || 0,
        });
        break;
      }
      case "SET_SETTING": {
        const settings = await getSettings();
        settings[msg.key] = msg.value;
        await chrome.storage.local.set({ settings });
        if (msg.key === "blockTrackers" || msg.key === "blockMedia")
          await syncDnrRules(settings);
        if (msg.key === "autoSuspend" && msg.value) {
          const tabs = await chrome.tabs.query({});
          tabs.forEach((t) => touch(t.id)); // reset timers when re-enabled
        }
        sendResponse({ ok: true });
        break;
      }
      case "SUSPEND_ALL": {
        await suspendAllOthers();
        sendResponse({ ok: true });
        break;
      }
      case "RESTORE_ALL": {
        await restoreAllTabs();
        sendResponse({ ok: true });
        break;
      }
      case "TOGGLE_WHITELIST": {
        const settings = await getSettings();
        const domain = String(msg.domain || "").toLowerCase().replace(/^www\./, "");
        if (domain) {
          if (msg.add) {
            if (!settings.whitelist.includes(domain)) settings.whitelist.push(domain);
          } else {
            settings.whitelist = settings.whitelist.filter((d) => d !== domain);
          }
          await chrome.storage.local.set({ settings });
        }
        sendResponse({ ok: true, whitelist: settings.whitelist });
        break;
      }
      case "GET_RESTORE_URL": {
        const data = await chrome.storage.local.get(`restore_${msg.tabId}`);
        sendResponse({ url: data[`restore_${msg.tabId}`] || null });
        break;
      }
      case "RESTORE_TAB": {
        const data = await chrome.storage.local.get(`restore_${msg.tabId}`);
        const url = data[`restore_${msg.tabId}`];
        if (url) {
          await chrome.tabs.update(msg.tabId, { url });
          await chrome.storage.local.remove(`restore_${msg.tabId}`);
          // Net RAM effect: this tab is active again.
          const cur =
            (await chrome.storage.local.get(RAM_SAVED_KEY))[RAM_SAVED_KEY] || 0;
          await chrome.storage.local.set({
            [RAM_SAVED_KEY]: Math.max(0, cur - EST_RAM_PER_TAB_MB),
          });
        }
        sendResponse({ ok: !!url });
        break;
      }
      case "GET_ACTIVE_TAB": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        let domain = null;
        try {
          domain = tab?.url ? new URL(tab.url).hostname.replace(/^www\./, "") : null;
        } catch {}
        sendResponse({ tabId: tab?.id ?? null, domain });
        break;
      }
    }
  })();
  return true; // keep channel open for async sendResponse
});
