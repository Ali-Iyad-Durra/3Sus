/**
 * 3Sus — suspended placeholder logic.
 * Reads the tab id from the URL, asks the service worker for the
 * original URL, and restores it when the user clicks "Click to Reload".
 */

const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tab"));

const saved = params.get("ram");
if (saved)
  document.getElementById("savedText").textContent = `~${saved} MB RAM freed`;

document.getElementById("reload").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "RESTORE_TAB", tabId });
});
