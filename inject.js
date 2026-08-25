/**
 * inject.js - runs in the PAGE's own JS context (not the content-script
 * isolated world), injected as an external <script src> by gql-bridge.js
 * (an inline <script> would be blocked by twitch.tv's CSP).
 *
 * Purpose: passively observe Twitch's own GraphQL traffic to
 * https://gql.twitch.tv/gql to detect "fake category" streams - a channel
 * listed under a game's drops-filtered directory that isn't actually
 * broadcasting with that game's drop campaign attached, so watching it
 * never accrues progress. Never issues a request of its own - read-only.
 *
 * Twitch batches GraphQL calls as a single POST whose body is an array of
 * {operationName, ...} entries, and the JSON response array comes back in
 * the same order as the request array (standard Apollo batch-link
 * behavior) - so requests and responses are paired up by index, and only
 * `operationName` (far more stable across Twitch deploys than the
 * accompanying persisted-query sha256 hash) is used to decide what to read.
 *
 * VERIFY BEFORE RELYING ON THIS IN PRODUCTION: Twitch's GQL schema is
 * private/undocumented and can change without notice. Open DevTools ->
 * Network -> filter "gql" while watching a real Drops-enabled channel and a
 * mistagged one, and confirm the operationNames and field paths in
 * EXTRACTORS below still match; update them if they've drifted. This
 * mirrors the same "best-effort, needs real-world verification" caveat
 * content.js already carries for its DOM selectors.
 */
(() => {
  const GQL_URL = "https://gql.twitch.tv/gql";
  const MSG_TYPE = "__DROP_CLAIMER_GQL__";

  function post(payload) {
    try {
      window.postMessage({ type: MSG_TYPE, payload }, window.location.origin);
    } catch { /* never let a messaging failure surface to the page */ }
  }

  // ---- extractors: operationName -> (responseBody) => signal | null --------
  const EXTRACTORS = {
    // Per-channel: which drop campaigns Twitch actually associates with
    // whatever is live on this channel right now. Empty/missing means this
    // stream isn't tagged for drops at all, no matter what the directory
    // category said - the core "fake category" signal.
    DropsHighlightService_AvailableDrops(body) {
      const campaigns = body?.data?.channel?.viewerDropCampaigns;
      if (campaigns === undefined) return null;
      return {
        kind: "channelCampaigns",
        campaignIds: (campaigns || []).map((c) => c && c.id).filter(Boolean),
      };
    },

    // Account-wide: minutes watched per in-progress campaign. Used to
    // confirm actual accrual over time on whichever channel is currently
    // the sole watch-tab for that game.
    Inventory(body) {
      const inProgress = body?.data?.currentUser?.inventory?.dropCampaignsInProgress;
      if (!inProgress) return null;
      return {
        kind: "inventory",
        campaigns: inProgress.map((c) => ({
          gameName: (c.game && c.game.displayName) || null,
          minutesWatched: Math.max(
            0,
            ...(c.timeBasedDrops || []).map((d) => (d.self && d.self.currentMinutesWatched) ?? 0),
            0
          ),
        })),
      };
    },
  };

  function parseJsonArray(text) {
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return null;
    }
  }

  function handleExchange(requestEntries, responseText) {
    const responseEntries = parseJsonArray(responseText);
    if (!responseEntries) return;

    responseEntries.forEach((resEntry, i) => {
      const name = requestEntries && requestEntries[i] && requestEntries[i].operationName;
      const extractor = name && EXTRACTORS[name];
      if (!extractor) return;
      const signal = extractor(resEntry);
      if (signal) post({ operationName: name, signal, at: Date.now() });
    });
  }

  // ---- fetch ----------------------------------------------------------------
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const promise = nativeFetch.call(this, input, init);
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (url && url.startsWith(GQL_URL)) {
        const body = init && typeof init.body === "string" ? init.body : null;
        const requestEntries = parseJsonArray(body);
        promise
          .then((res) => res.clone().text().then((text) => handleExchange(requestEntries, text)))
          .catch(() => {});
      }
    } catch { /* never break the page's real request */ }
    return promise;
  };

  // ---- XHR (Twitch's client mixes fetch and XHR across code paths) ---------
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dropClaimerIsGql = typeof url === "string" && url.startsWith(GQL_URL);
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__dropClaimerIsGql) {
      const requestEntries = parseJsonArray(typeof body === "string" ? body : null);
      this.addEventListener("load", () => {
        try { handleExchange(requestEntries, this.responseText); } catch { /* ignore */ }
      });
    }
    return nativeSend.call(this, body);
  };
})();
