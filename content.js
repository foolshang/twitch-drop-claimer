/**
 * Twitch Drop Auto-Claimer - content script
 * (loaded after shared.js - toSlug/ALIASES/channelFromUrl/directoryUrl come from there)
 *
 * Runs in several contexts:
 * 1. Any twitch.tv page  -> claim drop buttons wherever they appear
 * 2. Directory page (/directory/category/<slug>?filter=drops), when this tab
 *    is the designated "watch tab" -> pick the live channel with the fewest
 *    viewers and navigate to it
 * 3. Channel page, when this tab is the watch tab -> set lowest quality +
 *    mute, watch for offline/raid and bounce back to the directory
 * 4. Inventory page (/drops/inventory) -> claim buttons (existing) + parse
 *    campaign progress and report it to background for the auto-skip logic
 *
 * Everything can be started/stopped based on the `enabled` flag in
 * browser.storage.local, without reloading the page - changes are picked up
 * live via storage.onChanged. The auto-watch pieces (2/3/4's skip-logic) are
 * additionally gated on `autoWatchEnabled`.
 *
 * NOTE: the directory viewer-count parsing, the quality/mute menu clicks, and
 * the inventory progress parsing are all best-effort DOM heuristics - Twitch's
 * markup for these was not directly inspectable while writing this, so they
 * are intentionally "fail closed" (when in doubt, assume NOT done / NOT
 * claimed) and will likely need real-world selector fixes.
 */

(() => {
  const SCAN_INTERVAL_MS = 15_000;
  const CLICK_COOLDOWN_MS = 5_000;
  let lastClickAt = 0;
  let enabled = true; // default while the first storage read is in flight, so we don't miss a button that appears quickly
  let running = false;

  const log = (...args) => console.log("[DropClaimer]", ...args);

  // ---- claim button selectors -----------------------------------------------
  // Twitch changes attributes often; ordered from specific -> generic fallback
  const CLAIM_SELECTORS = [
    // inventory page
    'button[data-test-selector="DropsCampaignInProgressRewardPresentation-claim-button"]',
    // drop notification on the stream page (corner of the screen)
    'button[data-a-target="drops-claim-button"]',
    'div[data-test-selector="drops-notification"] button',
    // callout in chat ("Claim your reward" above the chat box)
    'button[data-a-target="chat-private-callout__primary-button"]',
    'div[data-test-selector="chat-private-callout"] button',
    'div[class*="callout"] button[class*="primary"]',
  ];

  // button text/aria-label considered a claim button (supports multiple UI languages)
  const CLAIM_TEXTS = [
    "claim", "claim now", "claim drop", "claim your reward", "claim reward",
    "รับรางวัล", "รับ",
  ];

  function textMatches(el) {
    const t = (el.textContent || "").trim().toLowerCase();
    const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
    return CLAIM_TEXTS.some((c) => t === c || aria === c || aria.startsWith(c));
  }

  function findClaimButtons() {
    const found = new Set();

    for (const sel of CLAIM_SELECTORS) {
      document.querySelectorAll(sel).forEach((b) => {
        // callout selectors can also match unrelated buttons -> check text first
        if (sel.includes("callout") ? textMatches(b) : true) found.add(b);
      });
    }

    // Generic fallback: scan every button and role=button element
    document.querySelectorAll('button, [role="button"]').forEach((b) => {
      if (textMatches(b)) found.add(b);
    });

    return [...found].filter((b) => !b.disabled && b.getAttribute("aria-disabled") !== "true");
  }

  async function recordClaim(text) {
    // persist the most recently claimed drop so the popup can display it,
    // and nudge background to refresh the inventory tab soon (debounced there)
    try {
      await browser.storage.local.set({ lastClaimAt: Date.now(), lastClaimText: text });
      browser.runtime.sendMessage({ type: "dropClaimed" }).catch(() => {});
    } catch (e) {
      log("recordClaim failed:", e);
    }
  }

  function clickClaims(reason) {
    if (!enabled) return; // in case a queued callback fires after the switch was already turned off

    const now = Date.now();
    if (now - lastClickAt < CLICK_COOLDOWN_MS) return;

    const buttons = findClaimButtons();
    if (buttons.length === 0) return;

    for (const btn of buttons) {
      try {
        const text = (btn.textContent || "").trim();
        btn.click();
        log(`claimed via ${reason}:`, text);
        recordClaim(text);
      } catch (e) {
        log("click failed:", e);
      }
    }
    lastClickAt = now;
  }

  // =========================================================================
  // page-type helpers
  // =========================================================================
  function isChannelPage() {
    const parts = location.pathname.split("/").filter(Boolean);
    return parts.length === 1 && !RESERVED_PATHS.has(parts[0].toLowerCase());
  }

  function isDirectoryPage() {
    return location.pathname.startsWith("/directory/category/");
  }

  function isInventoryPage() {
    return location.pathname.startsWith("/drops/inventory");
  }

  // A slug that doesn't map to any real Twitch category doesn't always
  // redirect the URL away (the directoryIntervalId check below already
  // catches that case) - confirmed live 2026-09-01: a wrong slug for a
  // renamed game (Twitch shows "Rainbow Six Siege" but the category slug is
  // still "tom-clancys-rainbow-six-siege"; the guessed
  // "rainbow-six-siege" slug kept the same URL) rendered with
  // document.title still the bare default "Twitch" and no <h1> at all -
  // indistinguishable from "the category is real but genuinely has 0 live
  // channels right now" using pickBestChannel() alone, which would
  // otherwise sit in the "nobody's live" cooldown forever and never get
  // flagged as the real bug it is. A real category's title/heading always
  // carries its name, even with zero viewers.
  function looksLikeUnknownCategory() {
    return document.title.trim() === "Twitch" && !document.querySelector("h1");
  }

  // Real DOM capture against a channel that actually went offline mid-session
  // found: the animated-viewer-count check alone tracked live/offline
  // correctly the whole time (true for a real live channel, false throughout
  // the real offline one), while a second check that used to be here - a
  // broad, unscoped `[class*='live-indicator']` match - stayed stuck `true`
  // through the entire offline session, and the captured bodyText at the same
  // moment showed only sidebar content (a Followed/Live Channels list), not
  // anything player-related - almost certainly matching some OTHER live
  // channel's badge in that sidebar list, not the one actually being
  // watched. Dropped rather than reintroduced scoped to a player container,
  // since there's no real DOM captured yet to build that scoped selector
  // from - see HISTORY.md.
  //
  // 2026-09-01: dumped the real channel-page DOM in both states over RDP
  // (warframe live vs ghazzytv offline). `.channel-root` - the single
  // element wrapping the whole channel page - carries state modifiers that
  // are React-state-driven and scoped to the viewed channel (never the
  // sidebar): `.channel-root--live` when live, `.channel-root__player--offline`
  // + `.channel-root__info--offline` when offline. The two were cleanly
  // mutually exclusive (1/0 either way) in the capture. The old
  // `.channel-status-info--offline` selector matched ZERO elements in both
  // dumps - fully stale; an autohosting-while-offline channel now uses
  // `.channel-status-info--autohost`, and `.channel-root__info--offline`
  // covers that case too.
  function looksLive() {
    return !!document.querySelector('[data-a-target="animated-channel-viewers-count"]');
  }

  function looksOffline() {
    // content gate (subscriber-only / mature / rerun) is NOT "offline"
    if (document.querySelector('[data-a-target="player-overlay-content-gate"]')) return false;
    // channel-page root reflecting an offline broadcast directly (scoped to
    // the viewed channel, verified against real DOM - see comment above)
    if (document.querySelector('.channel-root__player--offline, .channel-root__info--offline')) return true;
    // full-page offline recommendations carousel (only rendered when offline)
    if (document.querySelector('[data-a-target="home-offline-carousel"], [data-test-selector="offline-recommendations"]')) return true;
    const txt = document.body.innerText || "";
    return /is offline|ออฟไลน์อยู่/i.test(txt.slice(0, 5000));
  }

  // ask background whether this tab is the one it's using for auto-watch, and
  // which game it's currently supposed to be handling - prevents auto-watch
  // from ever touching a tab the user opened for their own viewing
  async function getWatchTabInfo() {
    try {
      const res = await browser.runtime.sendMessage({ type: "isWatchTab" });
      return res || { isWatchTab: false, activeGame: null };
    } catch {
      return { isWatchTab: false, activeGame: null };
    }
  }

  // isCancelled is polled each tick so the wait can be abandoned immediately
  // when stop() runs, instead of leaving an untracked setTimeout chain alive
  function waitFor(predicate, timeoutMs, isCancelled) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (isCancelled && isCancelled()) { resolve(false); return; }
        if (predicate() || Date.now() - start >= timeoutMs) { resolve(true); return; }
        inventoryWaitTimeoutId = setTimeout(tick, 500);
      };
      tick();
    });
  }

  // =========================================================================
  // Directory page: pick the live, lowest-viewer channel for the active game
  // =========================================================================
  // BEST-EFFORT / needs real-world verification against Twitch's current markup.
  function extractViewerCount(card) {
    const text = card.innerText || "";
    const m = text.match(/([\d,.]+)\s*([KM]?)\s*viewers?/i);
    if (!m) return null;
    let n = parseFloat(m[1].replace(/,/g, ""));
    if (/K/i.test(m[2])) n *= 1_000;
    if (/M/i.test(m[2])) n *= 1_000_000;
    return Math.round(n);
  }

  // blockedNames: channels rejected by the background verification check
  // (fake-category / no drop progress) - skipped so we don't immediately
  // re-pick the same bad stream.
  function pickBestChannel(blockedNames) {
    const blocked = blockedNames instanceof Set ? blockedNames : new Set(blockedNames || []);
    const links = document.querySelectorAll(
      'a[data-a-target="preview-card-image-link"], article a[data-a-target="preview-card-channel-link"]'
    );
    const candidates = [];
    const seen = new Set();
    links.forEach((link) => {
      const href = link.getAttribute("href");
      if (!href || seen.has(href)) return;
      seen.add(href);
      const card = link.closest("article") || link.parentElement;
      const viewers = card ? extractViewerCount(card) : null;
      const name = href.split("/").filter(Boolean).pop();
      candidates.push({ href, name, viewers: viewers ?? Infinity });
    });
    const usable = candidates.filter((c) => !blocked.has((c.name || "").toLowerCase()));
    if (usable.length === 0) return null;
    usable.sort((a, b) => a.viewers - b.viewers);
    return usable[0];
  }

  // =========================================================================
  // Channel page: lowest quality (BEST-EFFORT, needs verification)
  //
  // Muting is NOT done here - it's handled at the browser level by
  // background.js via tabs.update({muted:true}) right after the tab is
  // created, which is more reliable than clicking Twitch's own mute button
  // and can't be undone by the page re-rendering its player.
  // =========================================================================
  let qualityAttempts = 0;
  function applyLowQuality() {
    qualityAttempts++;
    try {
      const settingsBtn = document.querySelector('button[data-a-target="player-settings-button"]');
      if (settingsBtn) {
        settingsBtn.click();
        setTimeout(() => {
          const qualityItem = [...document.querySelectorAll('button, [role="menuitem"]')]
            .find((el) => /quality/i.test(el.textContent || ""));
          if (qualityItem) {
            qualityItem.click();
            setTimeout(() => {
              const options = [...document.querySelectorAll('input[type="radio"], [role="menuitemradio"]')];
              if (options.length > 0) {
                const lowest = options[options.length - 1]; // Twitch lists Auto first, lowest last
                (lowest.closest("label") || lowest).click();
              }
              settingsBtn.click(); // close the menu we opened
            }, 400);
          } else {
            settingsBtn.click();
          }
        }, 300);
      }
      log("applied quality setting (best-effort)");
      return true;
    } catch (e) {
      log("applyLowQuality failed:", e);
      return qualityAttempts >= 5; // stop retrying after 5 failed attempts
    }
  }

  // =========================================================================
  // Channel page: recover a player that never started (BEST-EFFORT)
  //
  // Live RDP capture (2026-09-04) found Twitch's own player intermittently
  // never issues the PlaybackAccessToken/usher fetch that sets video.src on
  // a tab this extension opened in the background (active:false) - the
  // <video> element sits at readyState 0 / currentTime 0 indefinitely (10+
  // min observed), with no console error, on some channels but not others -
  // looks like a race in Twitch's own lazy-mount logic for a tab that was
  // never actually visible, not something this extension's navigation
  // triggers deliberately. A manual click on the player overlay plus
  // video.play() reliably unstuck it in that capture. Only ever called on a
  // tab already confirmed to be our own watch tab (never the user's).
  // =========================================================================
  function nudgeStalledPlayer() {
    try {
      const v = document.querySelector("video");
      if (!v || v.readyState > 0 || v.currentTime > 0) return; // already started, nothing to do
      const overlay = document.querySelector('[data-a-target="player-overlay-click-handler"]');
      if (overlay) {
        const r = overlay.getBoundingClientRect();
        overlay.dispatchEvent(new MouseEvent("click", {
          bubbles: true, cancelable: true, view: window,
          clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
        }));
      }
      v.play().catch(() => {});
      log("nudged a stalled player (readyState was 0)");
    } catch (e) {
      log("nudgeStalledPlayer failed:", e);
    }
  }

  // =========================================================================
  // Inventory page: parse campaign progress (BEST-EFFORT, needs verification)
  // =========================================================================
  // Real /drops/inventory capture (see HISTORY.md) found each campaign
  // card only identified by a boxart <img> - no game name text anywhere in
  // the card (that only exists in the unrelated followed/live-channels
  // sidebar). Card boundary found by counting: walk up from the boxart img
  // until an ancestor contains exactly that one image, and its own parent
  // contains 2+ (i.e. we've stepped into the next card's shared wrapper) -
  // robust to the styled-components hash classes actually surrounding it
  // (verified against 7 real cards, correctly separated every time).
  const GAME_CARD_IMAGE_SELECTOR = '[data-test-selector="DropsCampaignInProgressDescription-game-card-image"]';

  function findCampaignCardBoundary(img) {
    let node = img;
    for (let i = 0; i < 12 && node; i++) {
      if (node.querySelectorAll(GAME_CARD_IMAGE_SELECTOR).length === 1) {
        const parent = node.parentElement;
        const parentImageCount = parent ? parent.querySelectorAll(GAME_CARD_IMAGE_SELECTOR).length : 99;
        if (!parent || parentImageCount >= 2) return node;
      }
      node = node.parentElement;
    }
    // The count-the-images walk above needs a sibling card to delimit against.
    // When the whole page has only ONE campaign left in "In Progress" (the
    // normal end state once every other game's drops are claimed/expired) that
    // delimiter never appears, and on Twitch's real, deeply-nested DOM the walk
    // runs out of steps still inside the boxart column - so fall back to the
    // first ancestor that also encloses a reward-tier progress bar. That node
    // is where the boxart column and the tier column meet: the card root.
    // Without this, a lone finished/expired campaign is read as total:0 and can
    // never be marked complete, so its watch tab (and the whole run) never ends.
    node = img;
    for (let i = 0; i < 8 && node; i++) {
      if (node.querySelectorAll(GAME_CARD_IMAGE_SELECTOR).length >= 2) break;
      if (node.querySelector('[role="progressbar"]')) return node;
      node = node.parentElement;
    }
    return img.parentElement || img;
  }

  // The boxart <img> src encodes a numeric id (".../{id}_IGDB-285x380.jpg")
  // confirmed (for a real, non-tracked Division 2 campaign, id 504463) to
  // equal Twitch's own GQL `game.id` exactly - gameIdMap (background.js,
  // learned from DropChannelCampaignsProgress, see inject.js) maps that id
  // to a game name so this card can be matched to a slug without ever
  // reading a name off the card itself.
  function extractGameIdFromBoxart(img) {
    const m = (img.src || "").match(/\/(\d+)_IGDB-/);
    return m ? m[1] : null;
  }

  // aria-valuenow/valuemax on each reward tier's own [role="progressbar"]
  // (a real ARIA role, unlike the styled-components classes around it) -
  // confirmed via real capture to already be a 0-100 percentage, at 100
  // exactly when a reward is fully watched. Far more direct than the old
  // text-regex approach, which relied on a "N/M min" pattern that no
  // longer appears anywhere in the current markup at all.
  function extractTierPercent(bar) {
    const now = parseFloat(bar.getAttribute("aria-valuenow"));
    const max = parseFloat(bar.getAttribute("aria-valuemax"));
    if (Number.isNaN(now) || Number.isNaN(max) || max <= 0) return null;
    return (now / max) * 100;
  }

  // Best-effort: real cards show "N% of X hours"/"N% of X minutes" text
  // right next to each tier's own progress bar (verified, e.g. "53% of 4
  // hours") - used only to convert a known percentage into a remaining-
  // minutes estimate for a tier that isn't done yet. Unlike the card
  // boundary and percentage above, exactly how tightly this text is scoped
  // per-tier vs bleeding into a neighboring tier hasn't been fully nailed
  // down against every real card layout - if this returns null, the tier
  // is still counted correctly by extractTierPercent, it's only the
  // minutes-remaining estimate that's skipped for it.
  function extractTierDurationMin(tierEl) {
    const text = (tierEl && tierEl.innerText) || "";
    let m = text.match(/of\s+(\d+)\s*hours?/i);
    if (m) return parseInt(m[1], 10) * 60;
    m = text.match(/of\s+(\d+)\s*minutes?/i);
    if (m) return parseInt(m[1], 10);
    return null;
  }

  // Best-effort campaign expiry date, used by the "soonest expiry first"
  // priority mode. Fails closed like everything else here: returns null
  // (unknown) rather than a guessed date whenever the text doesn't clearly
  // match one of these patterns, sanity-bounded to reject obvious parse
  // errors (dates more than ~2 years out).
  function extractExpiresAt(cardText) {
    let m = cardText.match(/(\d+)\s*days?\s*left/i);
    if (m) {
      const days = parseInt(m[1], 10);
      if (!Number.isNaN(days) && days >= 0 && days < 365) {
        return Date.now() + days * 24 * 60 * 60 * 1000;
      }
    }

    // The format actually seen on a real card (2026-09-01 RDP capture):
    // "End Date: Wed, Aug 26, 7:59 AM GMT+7" - an optional leading weekday,
    // then "<Month> <day>". This is an absolute date and is shown on both
    // active and already-ended cards, so a parsed date in the past is taken
    // at face value (the campaign really did end then) rather than rolled
    // forward a year. Trailing time/timezone ignored; day granularity is
    // enough for "soonest expiry first" ordering.
    m = cardText.match(/End Date:\s*(?:[A-Za-z]{3,9},?\s*)?([A-Za-z]{3,9}\s+\d{1,2})/i);
    if (m) {
      const ts = new Date(`${m[1]} ${new Date().getFullYear()}`).getTime();
      if (!Number.isNaN(ts) && Math.abs(ts - Date.now()) < 2 * 365 * 24 * 60 * 60 * 1000) return ts;
    }

    // "ends on Aug 26" / "ends Aug 26" - relative phrasing only ever used on
    // an in-progress campaign, so a date that looks already-past must mean
    // next year (Dec -> Jan wraparound).
    m = cardText.match(/ends?\s+(?:on\s+)?([A-Za-z]{3,9}\s+\d{1,2})/i);
    if (m) {
      const now = new Date();
      let candidate = new Date(`${m[1]} ${now.getFullYear()}`);
      if (!Number.isNaN(candidate.getTime())) {
        let ts = candidate.getTime();
        if (ts < Date.now() - 24 * 60 * 60 * 1000) {
          ts = new Date(`${m[1]} ${now.getFullYear() + 1}`).getTime();
        }
        if (!Number.isNaN(ts) && ts - Date.now() < 2 * 365 * 24 * 60 * 60 * 1000) return ts;
      }
    }

    return null;
  }

  // Only ever counts a reward as "claimed" when we find explicit, unambiguous
  // evidence (a progress bar at 100%). Anything we can't confirm is left as
  // "not yet claimed" - wrongly marking a campaign complete would make the
  // extension abandon a game that still has drops left, which is worse than
  // watching a finished campaign a little longer.
  //
  // gameIdMap: browser.storage.local's game.id -> game.name map, learned
  // by background.js from real GQL traffic (see inject.js/background.js) -
  // required now that no card shows a game name as text at all. A card
  // whose boxart id isn't in the map yet is skipped, not guessed at - it
  // picks itself back up the next scan once background.js has learned it.
  function parseInventoryCampaigns(watchList, gameIdMap) {
    const imgs = [...document.querySelectorAll(GAME_CARD_IMAGE_SELECTOR)];
    if (imgs.length === 0) return [];

    const results = [];
    for (const img of imgs) {
      const gameId = extractGameIdFromBoxart(img);
      const name = gameId && gameIdMap && gameIdMap[gameId];
      if (!name) continue; // id not learned yet - fails closed, see comment above

      const slug = toSlug(name);
      if (!watchList.some((g) => g.slug === slug)) continue; // not a game we're tracking

      const card = findCampaignCardBoundary(img);
      const cardText = card.innerText || "";
      const accountNotConnected = /connect.*account|link.*account|account not connected|เชื่อมต่อบัญชี/i.test(cardText);
      // real capture: current text is "This reward is no longer
      // available." - the previous "this drop...no longer/unavailable"
      // pattern required the literal word "drop" and never matched it
      const expired = /expired|no longer available|unavailable|หมดอายุ/i.test(cardText);

      const bars = [...card.querySelectorAll('[role="progressbar"]')];
      let claimed = 0;
      let timeRemainingMin = 0;
      let foundDuration = false;
      for (const bar of bars) {
        const percent = extractTierPercent(bar);
        if (percent == null) continue; // can't confirm -> doesn't count toward claimed or remaining time
        if (percent >= 100) { claimed++; continue; }
        const tierEl = bar.closest(".tw-tower") || bar.parentElement || bar;
        const durationMin = extractTierDurationMin(tierEl);
        if (durationMin != null) {
          timeRemainingMin += Math.round((durationMin * (100 - percent)) / 100);
          foundDuration = true;
        }
      }

      // A reading with no tier bars and no expired/not-connected text carries
      // nothing usable - the card almost certainly didn't finish rendering
      // (React is async) or the boundary walk missed. Emitting it anyway would
      // overwrite a real earlier reading in campaignProgress with claimed:0
      // total:0, which reads as "not done" forever. Skip it and let the prior
      // reading stand; the next scan picks it up once the DOM settles.
      if (bars.length === 0 && !expired && !accountNotConnected) continue;

      results.push({
        slug,
        label: name,
        claimed,
        total: bars.length,
        accountNotConnected,
        expired,
        expiresAt: extractExpiresAt(cardText),
        timeRemainingMin: foundDuration ? timeRemainingMin : null,
      });
    }
    return dedupeBySlugPreferringActive(results);
  }

  // A game can have more than one campaign card showing at once (e.g. an
  // old one past its end date still listed alongside a new active one) -
  // real capture caught exactly this for marvel-rivals. Since results are
  // per-card but background.js's mergeInventoryProgress/isGameDone key
  // everything by slug, multiple same-slug entries must be collapsed to
  // one before leaving this file, or whichever entry happens to land last
  // in DOM order silently wins - closing+reopening the watch tab for no
  // reason if the active one loses, or permanently abandoning a still-live
  // campaign if the expired one loses. A slug only counts as expired if
  // every one of its cards is expired.
  function dedupeBySlugPreferringActive(results) {
    const bySlug = new Map();
    for (const r of results) {
      const existing = bySlug.get(r.slug);
      if (!existing || (existing.expired && !r.expired)) bySlug.set(r.slug, r);
    }
    return [...bySlug.values()];
  }

  // =========================================================================
  // start()/stop() - every timer/observer lives here so it can be truly stopped
  // =========================================================================
  let observer = null;
  let scanIntervalId = null;
  let inventoryIntervalId = null;
  let inventoryScanIntervalId = null;
  let inventoryWaitTimeoutId = null;
  let inventoryFirstScanTimeoutId = null;
  let initialScanTimeoutId = null;
  let channelWatchIntervalId = null;
  let directoryIntervalId = null;
  let searchResolveTimeoutId = null;
  let playerNudgeTimeoutId = null;

  function start() {
    if (running) return; // avoid stacking duplicate timers when toggled ON/OFF rapidly
    running = true;

    // ---- MutationObserver: catch claim buttons as soon as they appear ------
    observer = new MutationObserver(() => clickClaims("observer"));
    observer.observe(document.body, { childList: true, subtree: true });

    // ---- repeating scan in case the observer misses something --------------
    scanIntervalId = setInterval(() => clickClaims("interval"), SCAN_INTERVAL_MS);

    if (isInventoryPage()) {
      // ---- scroll to the bottom and back to force lazy render ---------------
      inventoryIntervalId = setInterval(() => {
        const y = window.scrollY;
        window.scrollTo(0, document.body.scrollHeight);
        setTimeout(() => {
          if (!enabled) return;
          clickClaims("post-scroll");
          window.scrollTo(0, y);
        }, 1_500);
      }, 60_000);

      // ---- campaign progress for the auto-skip logic -------------------------
      const scanInventory = async () => {
        if (!enabled) return;
        const cfg = await browser.storage.local.get(["watchList", "gameIdMap"]);
        const watchList = cfg.watchList || [];
        if (watchList.length === 0) return;
        const campaigns = parseInventoryCampaigns(watchList, cfg.gameIdMap || {});
        // Sent even when empty: a watched game's card missing from this scan
        // is itself a signal (see mergeInventoryProgress's missing-card
        // reconciliation) - gating on campaigns.length here would silently
        // swallow the case where every watched game's card is gone from "In
        // Progress" (the common end state once the last one is claimed).
        browser.runtime.sendMessage({ type: "inventoryProgress", campaigns }).catch(() => {});
      };
      // React renders async - wait for campaign cards before the first read
      waitFor(
        () => document.querySelector(GAME_CARD_IMAGE_SELECTOR) !== null,
        15_000,
        () => !running
      ).then(() => {
        if (!running) return; // stop() ran while we were waiting - don't schedule anything else
        inventoryFirstScanTimeoutId = setTimeout(scanInventory, 1_000);
      });
      inventoryScanIntervalId = setInterval(scanInventory, 60_000);
    }

    // first scan after page load / after switching on
    initialScanTimeoutId = setTimeout(() => clickClaims("initial"), 3_000);

    // --- directory page: pick the live, lowest-viewer channel (only if this
    // tab is the designated watch tab)
    if (isDirectoryPage()) {
      let attempts = 0;
      directoryIntervalId = setInterval(async () => {
        if (!enabled) { clearInterval(directoryIntervalId); return; }

        const wt = await getWatchTabInfo();
        if (!wt.isWatchTab || !wt.activeGame) { clearInterval(directoryIntervalId); return; }

        const expectedSlug = wt.activeGame.slug;
        attempts++;

        // Twitch redirected us away from /directory/category/<slug> -> bad slug
        if (!location.pathname.startsWith(`/directory/category/${expectedSlug}`)) {
          log("directory redirected away from", expectedSlug, "to", location.pathname, "- treating as invalid slug (retried automatically later)");
          clearInterval(directoryIntervalId);
          browser.runtime.sendMessage({
            type: "directoryInvalid",
            slug: expectedSlug,
            actualPathname: location.pathname,
            actualHref: location.href,
          }).catch(() => {});
          return;
        }

        const picked = pickBestChannel(wt.blockedChannels);
        if (picked) {
          log("picked channel:", picked.href, "viewers:", picked.viewers);
          clearInterval(directoryIntervalId);
          browser.runtime.sendMessage({ type: "directoryPicked", slug: expectedSlug, channel: picked.name }).catch(() => {});
          location.href = `https://www.twitch.tv${picked.href}`;
          return;
        }

        // give the SPA a couple of ticks (~10s) to finish hydrating the
        // category title/heading before trusting its absence - a slug this
        // wrong never gets one at all, no matter how long we wait. Hand it
        // to background.js to look up the real slug via Twitch's own search
        // (see handleDirectoryUnknownCategory); it falls back to marking the
        // slug invalid if search can't resolve it either.
        if (attempts >= 2 && looksLikeUnknownCategory()) {
          log("directory page for", expectedSlug, "never got a category title/heading - likely a wrong slug (e.g. a renamed game); asking background to resolve the real slug via search");
          clearInterval(directoryIntervalId);
          browser.runtime.sendMessage({
            type: "directoryUnknownCategory",
            slug: expectedSlug,
            gameName: (wt.activeGame && (wt.activeGame.displayName || wt.activeGame.input)) || null,
          }).catch(() => {});
          return;
        }

        // nobody live after ~2 minutes of retrying -> move on to the next game
        if (attempts >= 24) {
          log("directory empty, giving up on", expectedSlug);
          clearInterval(directoryIntervalId);
          browser.runtime.sendMessage({ type: "directoryEmpty", slug: expectedSlug }).catch(() => {});
          return;
        }
      }, 5_000);
    }

    // --- search results page: report the top "category" result so
    // background.js can resolve a game name to Twitch's real directory slug
    // (see handleDirectoryUnknownCategory -> searchUrl). The
    // `a[data-a-target="search-result-category"]` link is a stable selector
    // (not a styled-components hash) and its href carries the canonical slug,
    // even for a game whose display name no longer matches its slug. Sent
    // unconditionally - background ignores it unless it opened this tab to
    // resolve a slug - so a user's own search costs one extra ignored message.
    if (location.pathname === "/search") {
      const term = new URLSearchParams(location.search).get("term");
      searchResolveTimeoutId = setTimeout(() => {
        if (!running || !term) return;
        const a = document.querySelector('a[data-a-target="search-result-category"]');
        const m = a && (a.getAttribute("href") || "").match(/\/directory\/category\/([^/?#]+)/);
        if (m) {
          browser.runtime.sendMessage({ type: "searchCategoryResult", term, slug: decodeURIComponent(m[1]) }).catch(() => {});
        }
      }, 5_000);
    }

    // --- channel page: quality/mute + offline/raid monitor (only if this tab
    // is the designated watch tab)
    if (isChannelPage()) {
      const initialChannel = channelFromUrl(location.href);
      let qualityApplied = false;
      let handled = false;

      // fast first recovery attempt - don't make a stalled player wait a
      // full 60s (channelWatchIntervalId below) for its first nudge
      playerNudgeTimeoutId = setTimeout(async () => {
        if (!enabled || handled) return;
        const wt = await getWatchTabInfo();
        if (wt.isWatchTab) nudgeStalledPlayer();
      }, 20_000);

      channelWatchIntervalId = setInterval(async () => {
        if (!enabled || handled) return;

        const wt = await getWatchTabInfo();
        if (!wt.isWatchTab) return; // not our tab - never touch the user's own viewing

        if (!qualityApplied) qualityApplied = applyLowQuality();
        nudgeStalledPlayer();

        const expectedSlug = wt.activeGame && wt.activeGame.slug;
        const currentChannel = channelFromUrl(location.href);

        // raid/host: Twitch navigated this tab away from the channel we picked
        if (initialChannel && currentChannel && currentChannel !== initialChannel) {
          handled = true;
          log("redirected away from", initialChannel, "to", currentChannel);
          browser.runtime.sendMessage({ type: "channelRedirected", slug: expectedSlug }).catch(() => {});
          if (expectedSlug) location.href = directoryUrl(expectedSlug);
          return;
        }

        if (!looksLive() && looksOffline()) {
          handled = true;
          log("channel offline:", initialChannel);
          browser.runtime.sendMessage({ type: "channelOffline", slug: expectedSlug }).catch(() => {});
          if (expectedSlug) location.href = directoryUrl(expectedSlug);
        }
      }, 60_000);
    }

    log("started on", location.pathname);
  }

  function stop() {
    if (!running) return;
    running = false;

    if (observer) observer.disconnect();
    observer = null;

    clearInterval(scanIntervalId);
    clearInterval(inventoryIntervalId);
    clearInterval(inventoryScanIntervalId);
    clearTimeout(inventoryWaitTimeoutId);
    clearTimeout(inventoryFirstScanTimeoutId);
    clearTimeout(initialScanTimeoutId);
    clearInterval(channelWatchIntervalId);
    clearInterval(directoryIntervalId);
    clearTimeout(searchResolveTimeoutId);
    clearTimeout(playerNudgeTimeoutId);
    scanIntervalId = inventoryIntervalId = inventoryScanIntervalId =
      inventoryWaitTimeoutId = inventoryFirstScanTimeoutId =
      initialScanTimeoutId = channelWatchIntervalId = directoryIntervalId =
      searchResolveTimeoutId = playerNudgeTimeoutId = null;

    log("stopped");
  }

  // ---- load the initial state + listen for live changes --------------------
  browser.storage.local.get("enabled").then((cfg) => {
    enabled = cfg.enabled ?? true;
    if (enabled) start();
    else log("disabled, not starting");
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.enabled) return;
    enabled = changes.enabled.newValue ?? true;
    if (enabled) start();
    else stop();
  });
})();
