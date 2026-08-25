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

  function looksLive() {
    // signals that the stream is live: LIVE badge or the animated viewer counter
    if (document.querySelector('[data-a-target="animated-channel-viewers-count"]')) return true;
    const badge = document.querySelector(".tw-channel-status-text-indicator, [class*='live-indicator']");
    if (badge && /live|ไลฟ์|สด/i.test(badge.textContent || "")) return true;
    return false;
  }

  function looksOffline() {
    // clear offline signals: offline banner / full-page past-broadcast recommendations
    if (document.querySelector('[data-a-target="player-overlay-content-gate"]')) return false; // content gate is not "offline"
    if (document.querySelector('.channel-status-info--offline')) return true;
    const el = document.querySelector('[data-a-target="home-offline-carousel"], [data-test-selector="offline-recommendations"]');
    if (el) return true;
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
  // Inventory page: parse campaign progress (BEST-EFFORT, needs verification)
  // =========================================================================
  function closestCampaignCard(el) {
    let node = el;
    for (let i = 0; i < 8 && node && node !== document.body; i++) {
      if (node.querySelector && node.querySelector("h1,h2,h3,h4,h5")) return node;
      node = node.parentElement;
    }
    return el.closest('[class*="campaign" i]') || el.parentElement || el;
  }

  function extractRemainingMinutes(rewards) {
    let total = 0;
    let found = false;
    for (const el of rewards) {
      const text = el.innerText || "";
      let m = text.match(/(\d+)\s*\/\s*(\d+)\s*(?:min|minute|นาที)/i);
      if (m) {
        const now = parseInt(m[1], 10);
        const max = parseInt(m[2], 10);
        if (!Number.isNaN(now) && !Number.isNaN(max) && max > now) {
          total += max - now;
          found = true;
        }
        continue;
      }
      m = text.match(/(\d+)\s*(?:min|minute|นาที)\s*(?:left|remaining|เหลือ)/i);
      if (m) {
        total += parseInt(m[1], 10);
        found = true;
      }
    }
    return found ? total : null;
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

    m = cardText.match(/ends?\s+(?:on\s+)?([A-Za-z]{3,9}\s+\d{1,2})/i);
    if (m) {
      const now = new Date();
      let candidate = new Date(`${m[1]} ${now.getFullYear()}`);
      if (!Number.isNaN(candidate.getTime())) {
        let ts = candidate.getTime();
        if (ts < Date.now() - 24 * 60 * 60 * 1000) {
          // already passed this year by more than a day -> must mean next year
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
  function parseInventoryCampaigns(watchList) {
    const rewardEls = [...document.querySelectorAll(
      '[data-test-selector*="DropsCampaignInProgressRewardPresentation"]'
    )];
    if (rewardEls.length === 0) return [];

    const cards = new Map();
    for (const el of rewardEls) {
      const card = closestCampaignCard(el);
      if (!cards.has(card)) cards.set(card, []);
      cards.get(card).push(el);
    }

    const results = [];
    for (const [card, rewards] of cards) {
      const heading = card.querySelector("h1,h2,h3,h4,h5");
      const name = (heading?.textContent || "").trim();
      if (!name) continue;

      const slug = toSlug(name);
      if (!watchList.some((g) => g.slug === slug)) continue; // not a game we're tracking

      const cardText = card.innerText || "";
      const accountNotConnected = /connect.*account|link.*account|account not connected|เชื่อมต่อบัญชี/i.test(cardText);
      const expired = /expired|this drop.*(no longer|unavailable)|หมดอายุ/i.test(cardText);

      let claimed = 0;
      for (const rewardEl of rewards) {
        const bar = rewardEl.querySelector('[role="progressbar"]');
        if (!bar) continue; // can't confirm -> don't count as claimed
        const now = parseFloat(bar.getAttribute("aria-valuenow"));
        const max = parseFloat(bar.getAttribute("aria-valuemax"));
        if (!Number.isNaN(now) && !Number.isNaN(max) && max > 0 && now >= max) claimed++;
      }

      results.push({
        slug,
        label: name,
        claimed,
        total: rewards.length,
        accountNotConnected,
        expired,
        expiresAt: extractExpiresAt(cardText),
        timeRemainingMin: extractRemainingMinutes(rewards),
      });
    }
    return results;
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
        const cfg = await browser.storage.local.get("watchList");
        const watchList = cfg.watchList || [];
        if (watchList.length === 0) return;
        const campaigns = parseInventoryCampaigns(watchList);
        if (campaigns.length > 0) {
          browser.runtime.sendMessage({ type: "inventoryProgress", campaigns }).catch(() => {});
        }
      };
      // React renders async - wait for reward elements before the first read
      waitFor(
        () => document.querySelector('[data-test-selector*="DropsCampaignInProgressRewardPresentation"]') !== null,
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
          log("directory redirected away from", expectedSlug, "- treating as invalid slug");
          clearInterval(directoryIntervalId);
          browser.runtime.sendMessage({ type: "directoryInvalid", slug: expectedSlug }).catch(() => {});
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

        // nobody live after ~2 minutes of retrying -> move on to the next game
        if (attempts >= 24) {
          log("directory empty, giving up on", expectedSlug);
          clearInterval(directoryIntervalId);
          browser.runtime.sendMessage({ type: "directoryEmpty", slug: expectedSlug }).catch(() => {});
          return;
        }
      }, 5_000);
    }

    // --- channel page: quality/mute + offline/raid monitor (only if this tab
    // is the designated watch tab)
    if (isChannelPage()) {
      const initialChannel = channelFromUrl(location.href);
      let qualityApplied = false;
      let handled = false;

      channelWatchIntervalId = setInterval(async () => {
        if (!enabled || handled) return;

        const wt = await getWatchTabInfo();
        if (!wt.isWatchTab) return; // not our tab - never touch the user's own viewing

        if (!qualityApplied) qualityApplied = applyLowQuality();

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
    scanIntervalId = inventoryIntervalId = inventoryScanIntervalId =
      inventoryWaitTimeoutId = inventoryFirstScanTimeoutId =
      initialScanTimeoutId = channelWatchIntervalId = directoryIntervalId = null;

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
