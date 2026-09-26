# ⚡ 3Sus — Chrome Extension (Manifest V3)

A lightweight Web Performance Booster that speeds up browsing, reduces RAM usage, and cleans up heavy web pages.

## Features

1. **Auto Tab Suspender** — Tabs inactive for 15+ minutes are swapped for a featherweight placeholder page with a **"Click to Reload"** button. Each suspended tab frees ~80 MB of RAM.
2. **Resource & Script Blocker** — `chrome.declarativeNetRequest` blocks known trackers (Google Analytics, DoubleClick, Facebook, Hotjar, Taboola, …) and ad networks before they render; optional autoplay media blocking.
3. **DOM & Animation Cleaner** — Toggle in the popup strips CSS transitions/animations, `@font-face` web fonts, background videos, shadows and blur filters on the current tab (fully reversible).
4. **Popup UI** — Modern dark UI with per-feature toggles, live stats (MB RAM saved / tabs suspended) and a **"Suspend All Other Tabs Now"** button.

## File structure

```
speedboost/
├── manifest.json        # MV3 manifest, minimal permissions
├── background.js        # Service worker: tab monitoring, timers, DNR rules, stats
├── content.js           # DOM & Animation Cleaner (injected on demand)
├── suspended.html       # Lightweight placeholder page
├── suspended.js         # "Click to Reload" restore logic
└── popup/
    ├── popup.html       # UI markup
    ├── popup.css        # Vanilla CSS (no frameworks)
    └── popup.js         # Popup logic & messaging
```

## Install & test locally (Developer Mode)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (toggle, top-right).
3. Click **Load unpacked** and select the `speedboost` folder.
4. Pin the extension to the toolbar (puzzle icon → pin).

### Verifying each feature

- **Auto-suspend:** open a few tabs, switch away, and wait (or temporarily lower `SUSPEND_AFTER_MS` in `background.js` to 30 seconds for testing). The tab becomes the 💤 placeholder; click **Reload** to restore.
- **Blockers:** visit a site using Google Analytics/Ads with DevTools → Network open — tracker requests appear as `failed (blocked)`.
- **DOM Cleaner:** open an animation-heavy site, flip the toggle — animations freeze, fonts fall back to system fonts. Toggle off to restore.
- **Suspend All:** click the button in the popup — every inactive tab is suspended instantly and stats update.

## Notes

- Suspension stores the original URL in `chrome.storage.local` (`restore_<tabId>`) so the service worker can restore it even after being restarted.
- Blocking media (`resourceTypes: ["media"]`) blocks audio/video streams; this intentionally also blocks intentionally-played media while enabled.
- The RAM-saved figure is an estimate (~80 MB/tab); adjust `EST_RAM_PER_TAB_MB` in `background.js`.
