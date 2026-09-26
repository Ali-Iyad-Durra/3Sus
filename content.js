/**
 * 3Sus — content script (DOM & Animation Cleaner).
 *
 * Injected on demand from the popup (chrome.scripting). It listens for
 * CLEAN_ON / CLEAN_OFF messages and strips heavy rendering work:
 *   - CSS transitions & animations
 *   - Web fonts (falls back to system fonts)
 *   - Background videos / decorative media
 *   - blur/shadow filter effects (expensive on GPU)
 *
 * Designed to be idempotent: toggling ON twice does nothing twice.
 */

(() => {
  if (window.__threeSusLoaded) return;
  window.__threeSusLoaded = true;

  const STYLE_ID = "3sus-cleaner";
  let active = false;

  const cleanCss = `
    /* Kill all transitions/animations for instant rendering */
    *, *::before, *::after {
      animation: none !important;
      transition: none !important;
      scroll-behavior: auto !important;
      text-shadow: none !important;
      box-shadow: none !important;
      filter: none !important;
      backdrop-filter: none !important;
      will-change: auto !important;
    }
  `;

  function applyOn() {
    if (active) return;
    active = true;

    // 1. Inject the CSS override.
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = cleanCss;
    document.documentElement.appendChild(style);

    // 2. Remove registered web fonts -> instant system font rendering.
    document
      .querySelectorAll("style, style[data-href], link[rel='stylesheet']")
      .forEach((tag) => {
        if (tag.textContent && /@font-face/i.test(tag.textContent)) {
          tag.dataset.sbSavedText = tag.textContent;
          tag.textContent = tag.textContent.replace(
            /@font-face\s*{[^}]*}/gi,
            "",
          );
        }
      });

    // 3. Strip background/decorative media (autoplays & huge videos).
    document
      .querySelectorAll("video[autoplay], video[loop], video[muted]")
      .forEach((v) => {
        if (!v.hasAttribute("controls")) {
          v.dataset.sbHidden = "1";
          v.style.display = "none";
          v.pause();
        }
      });

    // 4. Pause CSS-driven marquees/sprites.
    document.getAnimations?.().forEach((a) => a.cancel());
  }

  function applyOff() {
    if (!active) return;
    active = false;

    document.getElementById(STYLE_ID)?.remove();

    // Restore stripped @font-face rules.
    document.querySelectorAll("style[data-sb-saved-text]").forEach((tag) => {
      tag.textContent = tag.dataset.sbSavedText;
      delete tag.dataset.sbSavedText;
    });

    // Restore hidden background media.
    document.querySelectorAll("[data-sb-hidden]").forEach((el) => {
      el.style.display = "";
      delete el.dataset.sbHidden;
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "CLEAN_ON") applyOn();
    if (msg.type === "CLEAN_OFF") applyOff();
  });
})();
