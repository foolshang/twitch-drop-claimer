/**
 * inject.js - runs in the PAGE's own JS context (not the content-script
 * isolated world). Declared as a `"world": "MAIN"` content script in
 * manifest.json (matches *://www.twitch.tv/*, run_at document_start) - the
 * browser puts it directly into the page's JS realm itself, so it is never
 * subject to the page's own CSP. It still has no access to `browser.*`
 * extension APIs from MAIN world - nothing running in a page's own realm
 * does - so it talks back to the extension via window.postMessage, picked
 * up by gql-bridge.js (isolated world, same page) and relayed with
 * browser.runtime.sendMessage from there.
 *
 * Purpose: passively observe Twitch's own GraphQL traffic to
 * https://gql.twitch.tv/gql. Never issues a request of its own - read-only.
 *
 * Twitch batches GraphQL calls as a single POST whose body is an array of
 * {operationName, ...} entries, and the JSON response array comes back in
 * the same order as the request array (standard Apollo batch-link
 * behavior) - so requests and responses are paired up by index, and only
 * `operationName` (far more stable across Twitch deploys than the
 * accompanying persisted-query sha256 hash) is used to decide what to read.
 *
 * EXTRACTORS has two entries (DropChannelCampaignsProgress and Inventory,
 * see below), neither for drop-progress itself. It originally had a
 * DropsHighlightService_AvailableDrops extractor meant to catch "fake
 * category" streams (a channel listed under a game's drops directory that
 * isn't actually broadcasting with that game's drop campaign attached) from
 * the channel page's own per-channel GQL response. Verified with real
 * instrumentation against a real pinned/hidden auto-watch tab (195+ GQL
 * operations captured over one session) that this specific operation never
 * fires in a background (active:false) tab; Twitch only seems to issue it
 * from a mounted, visible player UI component. background.js's
 * verifyDropStatus() no longer depends on anything from this file for its
 * rotate-or-keep decision; it reads campaign progress scraped from the
 * /drops/inventory page's DOM instead (see content.js), specifically so a
 * DOM/GQL selector drifting can never again cause a live, crediting channel
 * to get wrongly rotated away (see HISTORY.md for a case where a second,
 * GQL-based signal - unrelated to this extractor - did exactly that).
 *
 * Both DropChannelCampaignsProgress and Inventory exist purely to teach
 * background.js the game.id -> game.name mapping (`gameIdMap` in
 * storage.local, see handleGqlDropSignal's "gameIds" branch) - neither
 * one's own per-campaign progress numbers are used for anything; the
 * /drops/inventory DOM scrape (content.js) stays the sole source of record
 * for actual progress, same "never let a drifting GQL/DOM selector alone
 * reject a live, crediting channel" reasoning as above. This mapping is
 * needed because real capture found the /drops/inventory page's own
 * campaign cards stopped showing the game name anywhere in their DOM at
 * all ("Marvel Rivals"/"Path of Exile 2" text only exists in the unrelated
 * followed/live-channels sidebar) - but each card's boxart <img> src does
 * encode a numeric id (".../{id}_IGDB-285x380.jpg") confirmed to equal
 * this game's own `game.id` exactly, so content.js can look a card's
 * boxart id up in gameIdMap instead of reading a name off the card.
 *
 * DropChannelCampaignsProgress fires from a real watch tab, but was
 * confirmed (via an ~85s real capture across all three tracked auto-watch
 * tabs, all headless/active:false) to never fire at all from a headless
 * tab - the one earlier sighting was from an untracked, presumably
 * visible tab. Inventory (fires once per /drops/inventory page load - an
 * earlier version of this file had this extractor and removed it for
 * being "useless for live progress" at that once-per-load cadence, which
 * is true but irrelevant here) was confirmed live to carry game.id
 * alongside game.name for every campaign shown there, including both
 * currently-tracked games - so it's the reliable source; the
 * DropChannelCampaignsProgress extractor is kept as a free bonus in case
 * it ever does fire, not as anything depended on.
 * DropsInventoryRewardGroupStatus, also real and fires there repeatedly,
 * has no game field at all (just per-reward-group claim status) - not
 * useful for the id->name mapping, still captured via RAW_DUMP_OPS below
 * purely for continued exploration (e.g. whether it ever carries a
 * currentMinutesWatched-style number that could one day be a faster
 * alternative to the DOM scrape).
 *
 * DEBUG INSTRUMENTATION: unconditionally posts `opSeen` (every operationName
 * seen, not just ones with an extractor) and a one-shot `install` event
 * (how early the fetch/XHR hooks went up, and page visibility at that
 * moment). Always sending these is intentional - gating in this page-world
 * script would need an async storage read that could itself lose the race
 * against the very first GQL call being observed. background.js is what
 * decides whether to print anything, gated on the `debugGql` storage flag.
 */
(() => {
  const GQL_URL = "https://gql.twitch.tv/gql";
  const MSG_TYPE = "__DROP_CLAIMER_GQL__";
  const RAW_DUMP_OPS = new Set([
    "DropsInventoryRewardGroupStatus",
    // seen firing from a real channel watch tab (unlike
    // DropsHighlightService_AvailableDrops, which never fires there at all)
    // - under investigation as a possible faster, per-channel replacement
    // for the /drops/inventory DOM scrape verifyDropStatus() currently uses
    // in background.js, IF its payload turns out to carry per-channel
    // progress. Not used for anything yet - this only captures the raw body
    // so that can actually be checked instead of guessed.
    "DropChannelCampaignsProgress",
    // real op, confirmed firing once per /drops/inventory page load. Not
    // used for live progress (once per load is too slow for that) but that's
    // irrelevant for gameIdMap, which only ever needs a fresh id->name read
    // once per reload cycle anyway - re-added here purely to capture its raw
    // body and check whether it carries game.id alongside game.displayName
    // (the pre-redesign extractor for this op only ever read displayName,
    // never confirmed whether id was sitting right next to it). If so this
    // is a strictly better gameIdMap source than DropChannelCampaignsProgress
    // since it's confirmed to fire on the inventory page itself, not
    // dependent on a channel tab's player UI being mounted.
    "Inventory",
  ]);
  const RAW_DUMP_MAX_LEN = 8000; // keep individual postMessage/log lines sane

  function post(payload) {
    try {
      window.postMessage({ type: MSG_TYPE, payload }, window.location.origin);
    } catch { /* never let a messaging failure surface to the page */ }
  }

  function safeStringify(obj) {
    try {
      const s = JSON.stringify(obj);
      return s.length > RAW_DUMP_MAX_LEN ? s.slice(0, RAW_DUMP_MAX_LEN) + "...[truncated]" : s;
    } catch {
      return "[unstringifiable]";
    }
  }

  // one-shot: how early the fetch/XHR hooks went up, and what the page
  // looked like at that moment (visibility matters for "does Twitch even
  // query drops in a hidden tab")
  post({
    install: {
      at: Date.now(),
      perfNowMs: Math.round(performance.now()),
      readyState: document.readyState,
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      href: location.href,
    },
  });

  let opSeq = 0;

  // ---- extractors: operationName -> (responseBody) => signal | null --------
  const EXTRACTORS = {
    // Not drop-progress data itself - this only teaches background.js the
    // game.id -> game.name mapping for whatever campaigns it mentions
    // (fires on channel tabs, confirmed for a non-tracked game so far - see
    // HISTORY.md). Needed because the /drops/inventory page's own campaign
    // cards (content.js's parseInventoryCampaigns) stopped showing the game
    // name anywhere in their DOM - real capture confirmed "Marvel Rivals"/
    // "Path of Exile 2" text only exists in the unrelated sidebar - but each
    // card's boxart <img> src encodes a numeric ID
    // (".../{id}_IGDB-285x380.jpg") that was confirmed (for a Division 2
    // campaign, id 504463) to match this query's own game.id exactly. So:
    // learn id->name here from wherever it's seen, then content.js matches
    // a card's boxart id against that map instead of reading a name from
    // the card at all.
    DropChannelCampaignsProgress(body) {
      const campaigns = body?.data?.channelDropCampaignsProgress;
      if (!Array.isArray(campaigns)) return null;
      const games = campaigns
        .map((c) => c && c.game)
        .filter((g) => g && g.id && g.name)
        .map((g) => ({ id: String(g.id), name: g.name }));
      if (games.length === 0) return null;
      return { kind: "gameIds", games };
    },
    // Confirmed live (2026-08-28): fires once per /drops/inventory page
    // load/reload, and its dropCampaignsInProgress[].game carries both id
    // and name for every campaign actually shown there - including both
    // currently-tracked games (marvel-rivals, tom-clancys-the-division-2),
    // unlike DropChannelCampaignsProgress above which was never observed to
    // fire at all from a headless (active:false) auto-watch tab. Same
    // "gameIds" signal shape as that extractor - either firing teaches
    // background.js the same gameIdMap.
    Inventory(body) {
      const campaigns = body?.data?.currentUser?.inventory?.dropCampaignsInProgress;
      if (!Array.isArray(campaigns)) return null;
      const games = campaigns
        .filter((c) => c && c.game && c.game.id && c.game.name)
        // Twitch's own campaign.status ("ACTIVE"/"EXPIRED") rides along here
        // for free - real capture found the same game.id can appear more
        // than once (an old campaign past its end date alongside a current
        // one), so this is a strictly more reliable "is there still a live
        // campaign for this game" signal than content.js scraping "no
        // longer available" text off a DOM card, which has no way to know
        // *which* of several same-game cards it's looking at.
        .map((c) => ({ id: String(c.game.id), name: c.game.name, active: c.status === "ACTIVE" }));
      if (games.length === 0) return null;
      return { kind: "gameIds", games };
    },
    // Fires once per /drops/campaigns page load (confirmed live 2026-09-01 -
    // does NOT fire on /drops/inventory). This is the ONLY complete list of
    // every drop campaign Twitch currently knows about, active or expired -
    // background.js uses it to (a) tell whether a game a user typed into the
    // watch list actually has an open campaign right now, and (b) resolve
    // that typed name to Twitch's own game.displayName. Each entry carries
    // game.id/displayName (NO slug in this query - derived via toSlug),
    // status ("ACTIVE"/"EXPIRED"), endAt, and self.isAccountConnected.
    // Emitted as a full snapshot (`snapshot: true`) so background.js replaces
    // its stored list wholesale rather than merging - a campaign that has
    // ended must be able to disappear.
    // Fires on essentially every twitch.tv page (the left sidebar). Its
    // stream/game nodes carry game.id + game.slug + game.displayName
    // together - the one place we reliably see the real directory-category
    // slug next to the id. background.js keeps an id -> slug map from this so
    // the open-campaign resolver (ViewerDropsDashboard has no slug, only
    // displayName) doesn't have to guess a slug via toSlug() and get it
    // wrong for a renamed game (e.g. "Rainbow Six Siege" whose slug is still
    // "tom-clancys-rainbow-six-siege").
    SideNav(body) {
      const out = [];
      const seen = new Set();
      const walk = (v, depth) => {
        if (!v || typeof v !== "object" || depth > 14) return;
        if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
        if (v.__typename === "Game" && v.id && v.slug && !seen.has(String(v.id))) {
          seen.add(String(v.id));
          out.push({ id: String(v.id), slug: String(v.slug), name: v.displayName || v.name || null });
        }
        for (const k in v) walk(v[k], depth + 1);
      };
      walk(body?.data, 0);
      return out.length ? { kind: "gameSlugs", games: out } : null;
    },
    ViewerDropsDashboard(body) {
      const campaigns = body?.data?.currentUser?.dropCampaigns;
      if (!Array.isArray(campaigns)) return null;
      const now = Date.now();
      const games = [];
      for (const c of campaigns) {
        if (!c || !c.game || !c.game.id || !c.game.displayName) continue;
        const endAt = c.endAt ? Date.parse(c.endAt) : NaN;
        const endAtMs = Number.isNaN(endAt) ? null : endAt;
        games.push({
          id: String(c.game.id),
          name: c.game.displayName,
          active: c.status === "ACTIVE" && (endAtMs == null || endAtMs > now),
          endAt: endAtMs,
          accountConnected: !!(c.self && c.self.isAccountConnected),
        });
      }
      if (games.length === 0) return null;
      return { kind: "openCampaigns", snapshot: true, games };
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
      const reqEntry = requestEntries && requestEntries[i];
      const name = reqEntry && reqEntry.operationName;

      // every operationName seen, matched or not - the only way to tell
      // "this query never fires here" apart from "it fires but our extractor
      // is wrong"
      opSeq++;
      post({
        opSeen: {
          operationName: name || null,
          seq: opSeq,
          at: Date.now(),
          visibilityState: document.visibilityState,
          hidden: document.hidden,
        },
      });

      // full raw body for ops under active investigation (RAW_DUMP_OPS), or
      // any response we couldn't pair with a named request at all -
      // requestEntries === null means parsing the *request* body itself
      // failed (not JSON, or not the array/object shape expected); name
      // missing with requestEntries != null means that request entry simply
      // has no operationName field. Both matter for figuring out why some
      // ops show up as "(unnamed)".
      if (!name || RAW_DUMP_OPS.has(name)) {
        post({
          rawOp: {
            operationName: name || null,
            seq: opSeq,
            at: Date.now(),
            requestParseFailed: requestEntries === null,
            request: reqEntry ? safeStringify(reqEntry) : null,
            response: safeStringify(resEntry),
          },
        });
      }

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
