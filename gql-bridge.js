/**
 * gql-bridge.js - runs at document_start, before Twitch's own bundle, so it
 * can inject inject.js (the page-world GQL sniffer) as early as possible
 * and relay its postMessage signals into the extension.
 *
 * Kept as its own tiny content script, separate from content.js, purely so
 * injection happens at document_start while the rest of content.js keeps
 * running at document_idle - no behavior of content.js depends on this file.
 */
(() => {
  const MSG_TYPE = "__DROP_CLAIMER_GQL__";

  const script = document.createElement("script");
  script.src = browser.runtime.getURL("inject.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || msg.type !== MSG_TYPE || !msg.payload) return;
    browser.runtime.sendMessage({ type: "gqlDropSignal", ...msg.payload }).catch(() => {});
  });
})();
