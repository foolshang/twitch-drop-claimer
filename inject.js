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
 * useful for the id->name mapping, so no extractor for it.
 *
 * Besides those, INTEGRITY_EXTRACTORS (below) watch four Drops operations for
 * Twitch refusing them: seen live (2026-09-30) a session/device Twitch had
 * flagged got `errors: [{message: "failed integrity check"}]` + null data for
 * ViewerDropsDashboard, DropsInventoryRewardGroupStatus and
 * DropsPage_ClaimDropRewards (the campaign list, the drops inside a campaign,
 * the claim itself) while every ordinary operation - Inventory included -
 * kept working. Clearing twitch.tv cookies and logging in again fixed it.
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

  // ---- integrity / account-link detection ----------------------------------
  // Passive as everything here: read the response of Drops operations and say
  // what Twitch answered. Signals (see background.js handleGqlDropSignal):
  //   integrityFailed  the operation was refused with "failed integrity ..."
  //   dropsOpOk        the operation worked - only sent for operations that
  //                    fail in a flagged session, so it proves the flag is gone
  //                    (Inventory answers fine even when flagged: no proof)
  //   claimNotLinked   a claim was refused because the game account is not
  //                    connected (NOT an integrity problem); `seq` numbers this
  //                    tab's claim requests so content.js can tell which
  //                    reward it belongs to
  const errorMessages = (body) => (Array.isArray(body && body.errors) ? body.errors : [])
    .map((e) => String((e && e.message) || ""));
  const isIntegrityError = (body) => errorMessages(body).some((m) => /failed integrity/i.test(m));
  const hasData = (body) => !!(body && body.data && typeof body.data === "object" &&
    Object.values(body.data).some((v) => v != null));
  const integrityOrOk = (proof) => (body) => {
    if (isIntegrityError(body)) return { kind: "integrityFailed" };
    if (proof && !(body && body.errors && body.errors.length) && hasData(body)) return { kind: "dropsOpOk" };
    return null;
  };

  // The exact shape of Twitch's "connect your account" refusal was never
  // captured, so this is deliberately loose: an error whose message or
  // extension code is about an unconnected/unlinked account, or the claim
  // payload itself saying the user account is not connected.
  const NOT_LINKED_MESSAGE = /(not|isn't|aren't)\s+(yet\s+)?(connected|linked)|connect your (twitch|game|account)|link (your|the) (game )?account|account\s+(is\s+)?not\s+(connected|linked)/i;
  const NOT_LINKED_CODE = /(NOT|UN)[_ ]?(CONNECTED|LINKED)|ACCOUNT[_ ]?(NOT[_ ]?)?(CONNECT|LINK)|NEEDS?[_ ]?(ACCOUNT[_ ]?)?(CONNECT|LINK)/i;
  function claimNotLinked(body) {
    if (isIntegrityError(body)) return false;
    const errs = Array.isArray(body && body.errors) ? body.errors : [];
    if (errs.some((e) => NOT_LINKED_MESSAGE.test(String((e && e.message) || "")) ||
        NOT_LINKED_CODE.test(String((e && e.extensions && e.extensions.code) || "")))) return true;
    const claim = body && body.data && body.data.claimDropRewards;
    return !!(claim && claim.isUserAccountConnected === false);
  }

  const INTEGRITY_EXTRACTORS = {
    ViewerDropsDashboard: integrityOrOk(true),
    DropsInventoryRewardGroupStatus: integrityOrOk(true),
    Inventory: integrityOrOk(false),
    DropsPage_ClaimDropRewards(body) {
      if (claimNotLinked(body)) return { kind: "claimNotLinked" };
      return integrityOrOk(true)(body);
    },
  };

  // The Inventory operation also lists every campaign the user has in progress
  // with what it takes to earn it (captured 2026-10-01: id, name, status,
  // game{id,name}, and allow.channels[{id,name,url}] - null when anyone's
  // channel counts). background.js uses it to tell a game's general campaign
  // from the ones restricted to named channels, whose inventory cards look the
  // same (see entryOwnsCard in shared.js). Always a full snapshot: a campaign
  // that is no longer in progress must disappear.
  const CAMPAIGN_EXTRACTORS = {
    Inventory(body) {
      const list = body?.data?.currentUser?.inventory?.dropCampaignsInProgress;
      if (!Array.isArray(list)) return null;
      const campaigns = list
        .filter((c) => c && c.id)
        .map((c) => {
          const channels = Array.isArray(c.allow && c.allow.channels)
            ? c.allow.channels.map((ch) => String((ch && ch.name) || "").toLowerCase()).filter(Boolean)
            : [];
          const endAt = c.endAt ? Date.parse(c.endAt) : NaN;
          return {
            id: String(c.id),
            name: c.name || null,
            status: c.status || null,
            endAt: Number.isNaN(endAt) ? null : endAt,
            gameId: c.game && c.game.id ? String(c.game.id) : null,
            gameName: (c.game && (c.game.name || c.game.displayName)) || null,
            channels: channels.length ? channels : null,
          };
        });
      return { kind: "inventoryCampaigns", campaigns };
    },
  };

  // claim requests made by this page so far, numbered in request order and
  // announced as `claimRequest` when they go out; the response's `seq` is the
  // request's (content.js pairs them with its own clicks)
  let claimSeq = 0;
  function reserveClaimSeqs(requestEntries) {
    const seqs = [];
    (requestEntries || []).forEach((r, i) => {
      if (r && r.operationName === "DropsPage_ClaimDropRewards") {
        seqs[i] = claimSeq++;
        post({ operationName: r.operationName, signal: { kind: "claimRequest", operationName: r.operationName, seq: seqs[i] }, at: Date.now() });
      }
    });
    return seqs;
  }

  function parseJsonArray(text) {
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return null;
    }
  }

  function handleExchange(requestEntries, responseText, claimSeqs) {
    const responseEntries = parseJsonArray(responseText);
    if (!responseEntries) return;

    responseEntries.forEach((resEntry, i) => {
      const reqEntry = requestEntries && requestEntries[i];
      const name = reqEntry && reqEntry.operationName;
      if (!name) return;
      const integrity = INTEGRITY_EXTRACTORS[name];
      if (integrity) {
        const signal = integrity(resEntry);
        if (signal) {
          if (claimSeqs && claimSeqs[i] != null) signal.seq = claimSeqs[i];
          post({ operationName: name, signal: { ...signal, operationName: name }, at: Date.now() });
        }
      }
      const campaigns = CAMPAIGN_EXTRACTORS[name];
      if (campaigns) {
        const signal = campaigns(resEntry);
        if (signal) post({ operationName: name, signal, at: Date.now() });
      }
      const extractor = EXTRACTORS[name];
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
        const claimSeqs = reserveClaimSeqs(requestEntries);
        promise
          .then((res) => res.clone().text().then((text) => handleExchange(requestEntries, text, claimSeqs)))
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
      const claimSeqs = reserveClaimSeqs(requestEntries);
      this.addEventListener("load", () => {
        try { handleExchange(requestEntries, this.responseText, claimSeqs); } catch { /* ignore */ }
      });
    }
    return nativeSend.call(this, body);
  };
})();
