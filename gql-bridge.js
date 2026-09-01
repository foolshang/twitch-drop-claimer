/**
 * gql-bridge.js - runs at document_start, isolated world, on every
 * *://www.twitch.tv/* page (directory, channel, inventory - all of them,
 * the matches pattern has no path restriction).
 *
 * inject.js (the page-world GQL sniffer) runs as a separate, declarative
 * `"world": "MAIN"` content script entry in manifest.json - the browser
 * puts it directly into the page's own JS realm, never through the page's
 * CSP. It still has no access to `browser.*` extension APIs from MAIN
 * world, so this file's only job is relaying its postMessage signals into
 * the extension via browser.runtime.sendMessage.
 */
(() => {
  const MSG_TYPE = "__DROP_CLAIMER_GQL__";

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || msg.type !== MSG_TYPE || !msg.payload) return;

    const payload = msg.payload;
    // inject.js's debug instrumentation (see its top-of-file comment) - kept
    // as separate message types so background.js's normal signal handling
    // doesn't have to branch on payload shape
    if (payload.install) {
      browser.runtime.sendMessage({ type: "gqlInstall", ...payload.install }).catch(() => {});
    } else if (payload.opSeen) {
      browser.runtime.sendMessage({ type: "gqlOpSeen", ...payload.opSeen }).catch(() => {});
    } else if (payload.rawOp) {
      browser.runtime.sendMessage({ type: "gqlRawOp", ...payload.rawOp }).catch(() => {});
    } else {
      browser.runtime.sendMessage({ type: "gqlDropSignal", ...payload }).catch(() => {});
    }
  });
})();
