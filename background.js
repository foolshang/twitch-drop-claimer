/**
 * Twitch Drop Auto-Claimer - background script
 * (loaded after shared.js - toSlug/channelFromUrl/directoryUrl come from there)
 *
 * Four independent jobs:
 *
 * 1. Inventory upkeep (unchanged from before): Twitch's inventory page
 *    doesn't always update progress live, so if a tab is open on
 *    twitch.tv/drops/inventory we reload it every 15 minutes so the content
 *    script can click any newly-available Claim buttons.
 *
 * 2. Auto-watch orchestration: given an ordered list of games
 *    (browser.storage.local `watchList`), keep one pinned background tab per
 *    eligible game open at once (up to `tabQuota` concurrently, default 3),
 *    each pointed at a live, low-viewer channel of its own game. Games
 *    beyond the quota queue up in priority order. A game's tab closes on its
 *    own the moment that game is fully claimed / expired / invalid / removed
 *    from the list - the other tabs are unaffected. Once every game in the
 *    list is done, all watch tabs close and the badge shows "done".
 *
 * 3. Drop-status verification: a channel a watch tab is parked on might
 *    never credit us - either it's a "fake category" stream (listed under a
 *    game's drops directory without that game's drop campaign actually
 *    attached) or it genuinely went offline/got raided away after being
 *    picked. Both cases have the exact same observable symptom (campaign
 *    progress stops moving) and the exact same fix (rotate to a different
 *    channel), so there is deliberately only ONE decision-maker for both:
 *    verifyDropStatus() cross-checks each watched channel against the
 *    campaign progress already scraped from the DOM of the always-open
 *    /drops/inventory tab (content.js's parseInventoryCampaigns, fed via the
 *    "inventoryProgress" message / mergeInventoryProgress()) a while after
 *    it's picked, and rotates the tab to the next channel if that campaign's
 *    numbers haven't moved. See the "drop-status verification" section below
 *    for the full decision logic.
 *
 *    content.js's own DOM check (looksLive()/looksOffline(), every 60s)
 *    still runs and still bounces the tab back to the directory as soon as
 *    it thinks a channel went offline or got raided - that's a real,
 *    valuable speedup (the tab physically leaves faster than waiting on
 *    campaign progress). What it must NOT do, and no longer does, is decide
 *    on its own that the channel should be rejected/blocklisted: a false
 *    positive there (DOM selectors are unverified against Twitch's actual
 *    markup, same caveat as every other DOM heuristic in this project)
 *    would blocklist a channel that was actually fine. Only
 *    verifyDropStatus's campaign-progress comparison may reject a channel.
 *    A prior version of this file also tried a DOM-independent GQL
 *    "playback beacon silence" signal (SendEvents) as a second, faster,
 *    independent rotation trigger - reverted after it produced false
 *    positives against live, crediting channels in practice; see HISTORY.md.
 *    Known accepted cost of the current single-decision-maker design: an
 *    offline channel can take up to VERIFY_DELAY_MS (17 min) to rotate away,
 *    traded deliberately for never wrongly rejecting a channel that's fine.
 *
 *    verifyDropStatus() used to instead sniff Twitch's own GraphQL
 *    responses from the *channel* tab itself (gql-bridge.js/inject.js)
 *    looking for DropsHighlightService_AvailableDrops. Verified with real
 *    instrumentation against a real pinned/hidden watch tab (195+ GQL
 *    operations captured over one session) that this operation - and every
 *    other drops-related one tried so far - never fires at all in a
 *    background (active:false) tab; Twitch apparently only issues it from a
 *    mounted, visible player UI component. gql-bridge.js/inject.js are kept
 *    only for the id->name / id->slug / open-campaign snapshot extractors
 *    (see inject.js), not for anything verifyDropStatus currently relies on.
 *
 * 4. Open-campaign snapshot: to tell whether a game the user added actually
 *    has a live drop campaign right now (and to resolve the typed name to
 *    Twitch's own game.displayName), refreshOpenCampaigns() opens
 *    /drops/campaigns in a transient background tab, captures the one
 *    ViewerDropsDashboard GQL response inject.js extracts from it, and
 *    closes the tab again. The result (`openCampaigns` in storage) drives
 *    annotateWatchListFromCampaigns() and autoWatchTick's lacksOpenCampaign()
 *    gate. See the "open drop-campaign snapshot" section below.
 *
 * All four are fully gated on the `enabled` flag in browser.storage.local -
 * once switched off, nothing here may open a tab, reload one, or fire a
 * request again. Auto-watch is additionally gated on `autoWatchEnabled`.
 *
 * Tab etiquette (verified below, not just assumed):
 *   - every tabs.create/tabs.update call below passes an explicit
 *     `active: false`, with ONE deliberate, narrow exception:
 *     flashTabToStartPlayback() briefly sets `active: true` then back to
 *     `false` a few seconds later, and ONLY after the caller has confirmed
 *     (via tab.windowId) the tab is inside the dedicated watch window from
 *     getOrCreateWatchWindow() - never the window the user is actually
 *     using. It exists because live RDP capture (2026-09-04) found Twitch's
 *     own player sometimes never starts video at all in a tab that was
 *     created active:false and never once became its window's active tab -
 *     no console error, intermittent per channel. A background window kept
 *     minimized was tried first instead (avoids ever touching `active` at
 *     all) but live-verified NOT to work: `document.visibilityState` stays
 *     `"hidden"` for a minimized window (also for one positioned off-screen
 *     - Firefox's occlusion tracking, not just the `minimized` flag,
 *     decides this) and Twitch's player never starts either way. The flash
 *     was the only thing confirmed to reliably fix it.
 *   - muting is done at the browser level via tabs.update({muted:true})
 *     right after a watch tab is created - never by clicking Twitch's own
 *     mute button (that part was removed from content.js).
 *   - windows.update({focused:true}) is never called anywhere in this file.
 *     The one window-focus-adjacent call, getOrCreateWatchWindow()'s
 *     windows.create(), is a one-time (per browser session) creation of the
 *     dedicated watch window - not a per-tab focus grab.
 *   - content.js's own same-tab `location.href = ...` navigation (picking a
 *     channel from the directory, bouncing back to the directory on
 *     offline/raid) never changes tab activation - navigating a page's own
 *     location is not a WebExtension action and has no "active" concept, so
 *     a background tab navigating itself stays in the background. This is
 *     inherent browser behavior, not something this file needs to enforce.
 */

// unconditional, first thing this script does on every load/reload - proves
// which build of background.js is actually running, independent of
// anything else. Compare against the BUILD_MARKER value in shared.js.
console.log(
  "[DropClaimer] BUILD_MARKER =", BUILD_MARKER,
  "| manifest version =", browser.runtime.getManifest().version,
  "| loaded at", new Date().toISOString()
);

const RELOAD_ALARM = "reload-inventory";
const RELOAD_PERIOD_MIN = 15;
const AUTO_OFF_ALARM = "auto-off-check";
const AUTO_OFF_PERIOD_MIN = 10;
const AUTO_WATCH_ALARM = "auto-watch-tick";
const AUTO_WATCH_PERIOD_MIN = 1;
const INVENTORY_URL = "https://www.twitch.tv/drops/inventory";
// The only page that fires ViewerDropsDashboard (confirmed live 2026-09-01 -
// /drops/inventory does not). Opened in a transient background tab just long
// enough to capture that one GQL response, then closed - see
// refreshOpenCampaigns().
const CAMPAIGNS_URL = "https://www.twitch.tv/drops/campaigns";
// how stale the openCampaigns snapshot may be before autoWatchTick refuses
// to act on "this game has no open campaign" (fail open on older data)
const OPEN_CAMPAIGNS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// autoWatchTick kicks off a background refresh once the snapshot is older
// than this
const OPEN_CAMPAIGNS_REFRESH_MS = 45 * 60 * 1000;
const DEFAULT_TAB_QUOTA = 3;
const EMPTY_COOLDOWN_MS = 5 * 60 * 1000; // how long a "nobody live" game sits out before retrying
// how long a game sits out after its directory page looked "invalid"
// (content.js's directoryIntervalId found the tab redirected away from
// /directory/category/<slug>) before automatically retrying. Used to be
// permanent (never retried at all) until a real, confirmed-real category
// ("path-of-exile-2" - actively watched with real progress minutes earlier
// the same session) got marked invalid, meaning "invalid" can be a
// transient false read (timing/redirect race), not always a genuinely
// wrong slug - same principle as EMPTY_COOLDOWN_MS/CHANNEL_BLOCK_COOLDOWN_MS
// above: never permanently give up on a signal that might be wrong.
const INVALID_SLUG_RETRY_MS = 45 * 60 * 1000;

// drop-status verification: catches channels that are listed under a game's
// drops directory but aren't actually broadcasting with that game's drop
// campaign attached ("fake category"), so watching them never accrues
// progress. See verifyDropStatus() below.
//
// This has to be long enough that the /drops/inventory tab's own numbers
// have had a real chance to change, not just long enough for our own code
// to re-check. content.js re-scrapes the inventory DOM every 60s regardless
// of whether Twitch's underlying data changed, so a short delay here would
// mostly measure "did content.js happen to re-scan" rather than "did this
// channel actually credit us" - a false-positive rotation trap. The one
// guaranteed-fresh data point we have is RELOAD_ALARM's periodic hard
// reload of the inventory tab (RELOAD_PERIOD_MIN), so this is set to
// comfortably outlast one full reload cycle.
const VERIFY_DELAY_MS = (RELOAD_PERIOD_MIN + 2) * 60 * 1000; // 17 min
const CHANNEL_BLOCK_COOLDOWN_MS = 45 * 60 * 1000; // don't immediately re-pick a channel we just rejected
const UNUSABLE_CHANNEL_COOLDOWN_MS = 20 * 60 * 1000; // offline / switched game (see handleChannelUnusable)

// A watched game's card vanishing from /drops/inventory's "In Progress"
// section (parseInventoryCampaigns returning nothing for its slug) usually
// means every reward tier just got claimed and Twitch moved/removed the card
// - but a single miss could just be a mid-render hiccup. Require this many
// consecutive scans (each ~60s apart, content.js's inventoryScanIntervalId)
// with the card absent before inferring allComplete, matching the fail-closed
// posture used everywhere else in this file.
const REQUIRED_MISSING_SCANS = 2;

// In-memory ring buffer of every log() line this file emits (rejectChannel,
// handleChannelUnusable's "unusable (offline|game:<slug>)" line, verify, ...).
// exportDebugLogToFile() below writes it to a plain-text file so it can be
// read without needing remote-debugging access to the user's real, logged-in
// browser profile - see HISTORY.md 2026-09-27.
const DEBUG_LOG_MAX_LINES = 1000;
const debugLogBuffer = [];
function pushDebugLog(line) {
  debugLogBuffer.push(line);
  if (debugLogBuffer.length > DEBUG_LOG_MAX_LINES) debugLogBuffer.shift();
}

const log = (...args) => {
  const rendered = args.map((a) => {
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(" ");
  pushDebugLog(`[${new Date().toISOString()}] [bg] ${rendered}`);
  console.log("[DropClaimer]", ...args);
};

// Firefox's downloads API resolves a bare relative filename against whatever
// folder the browser is actually configured to save downloads to
// (browser.download.dir) - NOT necessarily a folder literally named
// "Downloads" (confirmed live: this project's own test profile has it set to
// D:\Browser). conflictAction "overwrite" + a fixed name keeps this one file
// up to date across writes instead of piling up "(1)", "(2)", ... copies.
// exportDebugLogToFile() resolves the real on-disk path via
// downloads.search() rather than asserting one, so the popup can show where
// the file actually landed instead of guessing wrong.
const DEBUG_LOG_FILENAME = "twitch-drop-claimer-debug.log";
async function exportDebugLogToFile() {
  const text = debugLogBuffer.length ? debugLogBuffer.join("\n") + "\n" : "(no log lines yet)\n";
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  try {
    const id = await browser.downloads.download({
      url,
      filename: DEBUG_LOG_FILENAME,
      conflictAction: "overwrite",
      saveAs: false,
    });
    for (let i = 0; i < 20; i++) {
      const [item] = await browser.downloads.search({ id });
      if (item && item.state === "complete") return { ok: true, path: item.filename };
      if (item && item.state === "interrupted") return { ok: false, error: item.error || "interrupted" };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: true, path: null }; // still in progress - unusual for a small text blob, don't block on it forever
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    // give the download time to actually read the blob before revoking
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

// Auto-export is throttled (rather than firing on every single event) so a
// burst of channel rotations doesn't spam the user's Downloads folder/toolbar
// with repeated overwrites of the same file.
const AUTO_EXPORT_MIN_INTERVAL_MS = 5 * 60 * 1000;
let lastAutoExportAt = 0;
function maybeAutoExportDebugLog() {
  const now = Date.now();
  if (now - lastAutoExportAt < AUTO_EXPORT_MIN_INTERVAL_MS) return;
  lastAutoExportAt = now;
  exportDebugLogToFile().then((r) => {
    if (!r.ok) log("auto debug-log export failed:", r.error);
  });
}

// serializes every auto-watch mutation so concurrent tab events (multiple
// games finishing/going offline near-simultaneously) can't race each other
// on a storage.local read-modify-write
let taskChain = Promise.resolve();
function serialized(fn) {
  const run = taskChain.then(fn, fn);
  taskChain = run.catch(() => {});
  return run;
}

// ============================================================================
// badge
// ============================================================================
async function refreshBadge() {
  const cfg = await browser.storage.local.get(["enabled", "watchPhase", "uiLang"]);
  const enabled = cfg.enabled ?? true;
  const navLang = typeof navigator !== "undefined" ? navigator.language : "";
  const lang = i18nResolveLang(cfg.uiLang, navLang);

  if (!enabled) {
    browser.browserAction.setBadgeText({ text: "OFF" });
    browser.browserAction.setBadgeBackgroundColor({ color: "#6d6d75" });
    browser.browserAction.setTitle({ title: i18nT(lang, "tt_off") });
    return;
  }

  if (cfg.watchPhase === "all-done") {
    browser.browserAction.setBadgeText({ text: "✓" });
    browser.browserAction.setBadgeBackgroundColor({ color: "#00f593" });
    browser.browserAction.setTitle({ title: i18nT(lang, "tt_all_done") });
    return;
  }

  browser.browserAction.setBadgeText({ text: "" });
  browser.browserAction.setBadgeBackgroundColor({ color: "#00f593" });
  browser.browserAction.setTitle({ title: i18nT(lang, "tt_running") });
}

// ============================================================================
// dedicated watch window - isolates every tab this extension opens from
// whatever the user is actually doing (see the tab-etiquette comment at the
// top of this file). Needed for the brief active:true flash in
// handleDirectoryPicked below: Twitch's own player does not reliably start
// video in a tab that has never been the active tab of its window (live RDP
// capture, 2026-09-04 - some channels' players simply never issue the
// PlaybackAccessToken/usher fetch otherwise, no console error). A flash is
// the only thing confirmed to fix that, so it must happen somewhere the
// user is never looking - a separate window they didn't ask to see, not a
// tab switch in whatever window they're using for YouTube/anything else.
// ============================================================================
// Returns { id, freshlyCreated }. freshlyCreated tells callers whether this
// call's window is the one that just got its initial tab navigated to
// INVENTORY_URL right here - openInventoryIfMissing() relies on that
// instead of re-querying browser.tabs right after, because whether
// browser.tabs.query() reflects a just-created/just-navigated tab by the
// very next call is not guaranteed (produced a real duplicate inventory tab
// in a live test, 2026-09-04).
let watchWindowCreateInFlight = null;
async function getOrCreateWatchWindow() {
  const cfg = await browser.storage.local.get("watchWindowId");
  if (cfg.watchWindowId) {
    try {
      await browser.windows.get(cfg.watchWindowId);
      return { id: cfg.watchWindowId, freshlyCreated: false };
    } catch {
      // closed by the user (or gone) - fall through and make a new one
    }
  }
  if (watchWindowCreateInFlight) return watchWindowCreateInFlight;
  watchWindowCreateInFlight = (async () => {
    try {
      const win = await browser.windows.create({ type: "normal" }); // blank - navigated below
      await browser.storage.local.set({ watchWindowId: win.id });
      const initialTab = win.tabs && win.tabs[0];
      if (initialTab) {
        try { await browser.tabs.update(initialTab.id, { url: INVENTORY_URL }); } catch { /* best-effort */ }
      }
      return { id: win.id, freshlyCreated: true };
    } catch (e) {
      log("getOrCreateWatchWindow: could not create a dedicated window, falling back to the current window:", e);
      return { id: null, freshlyCreated: false };
    } finally {
      watchWindowCreateInFlight = null;
    }
  })();
  return watchWindowCreateInFlight;
}

// ============================================================================
// inventory tab upkeep
// ============================================================================
async function openInventoryIfMissing() {
  const tabs = await browser.tabs.query({ url: "*://www.twitch.tv/drops/inventory*" });
  if (tabs.length === 0) {
    const { id: watchWindowId, freshlyCreated } = await getOrCreateWatchWindow();
    if (freshlyCreated) {
      // its initial tab was already navigated to INVENTORY_URL
      log("dedicated watch window created with the inventory tab already open");
    } else {
      await browser.tabs.create({ url: INVENTORY_URL, active: false, pinned: true, ...(watchWindowId ? { windowId: watchWindowId } : {}) });
      log("opened inventory tab");
    }
  }
}

let dropClaimedDebounce = null;
async function handleDropClaimed() {
  if (dropClaimedDebounce) return;
  dropClaimedDebounce = setTimeout(() => { dropClaimedDebounce = null; }, 60_000);

  const tabs = await browser.tabs.query({ url: "*://www.twitch.tv/drops/inventory*" });
  for (const tab of tabs) {
    if (!tab.active) browser.tabs.reload(tab.id);
  }
}

// ============================================================================
// open drop-campaign snapshot  (/drops/campaigns -> ViewerDropsDashboard GQL)
// ============================================================================
// Lets the watch list tell, per game, whether Twitch has an OPEN drop
// campaign for that game right now, and resolves the user's typed name to
// Twitch's own game.displayName/slug. /drops/campaigns is the only page that
// fires ViewerDropsDashboard (confirmed live 2026-09-01), so it's opened in
// a transient background tab just long enough to capture that one response
// (inject.js's extractor -> handleGqlDropSignal below), then closed again.

let campaignsRefreshInFlight = null;
let campaignsSignalWaiters = [];
// set true only while annotateWatchListFromCampaigns() writes watchList back,
// so the storage.onChanged handler doesn't treat our own rewrite as a
// user edit and loop
let suppressWatchListReaction = false;

function notifyCampaignsSignal() {
  const waiters = campaignsSignalWaiters;
  campaignsSignalWaiters = [];
  for (const w of waiters) w();
}

// Opens CAMPAIGNS_URL long enough to capture one ViewerDropsDashboard
// response (stored as `openCampaigns` by handleGqlDropSignal), then closes
// the tab. Concurrent callers share one in-flight run. With `maxAgeMs`,
// returns the existing snapshot untouched if it's younger than that.
async function refreshOpenCampaigns({ maxAgeMs = 0 } = {}) {
  if (maxAgeMs) {
    const { openCampaigns } = await browser.storage.local.get("openCampaigns");
    if (openCampaigns && openCampaigns.fetchedAt && Date.now() - openCampaigns.fetchedAt < maxAgeMs) {
      return openCampaigns;
    }
  }
  if (campaignsRefreshInFlight) return campaignsRefreshInFlight;

  campaignsRefreshInFlight = (async () => {
    let tab = null;
    try {
      const { id: watchWindowId } = await getOrCreateWatchWindow();
      tab = await browser.tabs.create({ url: CAMPAIGNS_URL, active: false, pinned: true, ...(watchWindowId ? { windowId: watchWindowId } : {}) });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 30_000);
        campaignsSignalWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    } catch (e) {
      log("refreshOpenCampaigns: could not open campaigns tab:", e);
    } finally {
      if (tab) { try { await browser.tabs.remove(tab.id); } catch { /* already gone */ } }
      campaignsRefreshInFlight = null;
    }
    const { openCampaigns } = await browser.storage.local.get("openCampaigns");
    return openCampaigns || null;
  })();

  return campaignsRefreshInFlight;
}

// One entry per real category slug, aggregating across a game's multiple
// campaigns (a game can list an ACTIVE and an EXPIRED campaign at once).
// `gameSlugMap` (id -> slug, learned from SideNav GQL) is preferred over
// toSlug(displayName) because ViewerDropsDashboard carries no slug and
// toSlug guesses wrong for renamed games (Rainbow Six Siege etc.).
function buildOpenCampaignsSnapshot(games, gameSlugMap = {}) {
  const bySlug = {};
  for (const g of games) {
    const slug = gameSlugMap[String(g.id)] || toSlug(g.name);
    if (!slug) continue;
    const cur = bySlug[slug] || {
      slug, gameId: String(g.id), displayName: g.name,
      active: false, endAt: null, accountConnected: false,
    };
    cur.active = cur.active || !!g.active;
    cur.accountConnected = cur.accountConnected || !!g.accountConnected;
    if (g.endAt != null) {
      if (g.active) {
        // latest end among the game's ACTIVE campaigns (last one to expire)
        cur.endAt = cur.endAt == null ? g.endAt : Math.max(cur.endAt, g.endAt);
      } else if (!cur.active && cur.endAt == null) {
        // no open campaign: keep the most recent end so the popup can still
        // say when the last one ended
        cur.endAt = g.endAt;
      }
    }
    bySlug[slug] = cur;
  }
  return bySlug;
}

// Re-resolves every watch-list entry against the current openCampaigns
// snapshot: binds it to Twitch's own displayName/slug/gameId when a matching
// OPEN campaign exists and records whether one is open (`campaign.open`).
// Only writes watchList back when a meaningful field changed. MUST NOT be
// called from inside a serialized() block - it runs its own, and then a
// serialized(autoWatchTick), so nesting would deadlock the task chain.
async function annotateWatchListFromCampaigns() {
  await serialized(async () => {
    const cfg = await browser.storage.local.get(["watchList", "openCampaigns"]);
    const list = cfg.watchList || [];
    const oc = cfg.openCampaigns;
    if (list.length === 0 || !oc || !oc.bySlug) return;

    const activeCampaigns = Object.values(oc.bySlug).filter((c) => c.active);
    let listChanged = false;

    const next = list.map((g) => {
      const match =
        matchOpenCampaign(g.input, activeCampaigns) ||
        (oc.bySlug[g.slug] && oc.bySlug[g.slug].active ? oc.bySlug[g.slug] : null);

      const slug = match ? match.slug : g.slug;
      const displayName = match ? match.displayName : (g.displayName || null);
      const gameId = match ? match.gameId : (g.gameId || null);
      const campaign = match
        ? { open: true, endAt: match.endAt ?? null, accountConnected: !!match.accountConnected, checkedAt: oc.fetchedAt }
        : { open: false, checkedAt: oc.fetchedAt };

      const prev = g.campaign || {};
      if (
        g.slug !== slug || g.displayName !== displayName || g.gameId !== gameId ||
        prev.open !== campaign.open || prev.endAt !== campaign.endAt ||
        prev.accountConnected !== campaign.accountConnected
      ) {
        listChanged = true;
      }
      return { ...g, slug, displayName, gameId, campaign };
    });

    if (listChanged) {
      suppressWatchListReaction = true;
      try {
        await browser.storage.local.set({ watchList: next });
      } finally {
        suppressWatchListReaction = false;
      }
    }
  });
  await serialized(autoWatchTick);
}

// ============================================================================
// auto-off - turn the master switch off once there's nothing left to watch
// (every tracked game fully claimed / expired / has no open campaign). Driven
// mainly by finishAllDone() the instant that happens; the AUTO_OFF_ALARM run
// is just a backstop in case that path was somehow missed.
// ============================================================================
async function checkAutoOff() {
  const cfg = await browser.storage.local.get(["enabled", "autoOffEnabled", "watchPhase", "enabledSince"]);
  if (!cfg.enabled || !cfg.autoOffEnabled) return;
  if (cfg.watchPhase !== "all-done") return;
  // grace window right after a manual re-enable so flipping the switch back
  // on (e.g. to add games / wait for new campaigns) isn't instantly undone
  if (cfg.enabledSince && Date.now() - cfg.enabledSince < 3 * 60 * 1000) return;
  log("auto-off: every tracked game is done -> turning the master switch off");
  await browser.storage.local.set({ enabled: false, completedAllAt: Date.now() });
}

// ============================================================================
// auto-watch orchestration - one tab per eligible game, up to tabQuota
// ============================================================================
function isGameDone(slug, campaignProgress, invalidSlugs) {
  if (invalidSlugs && (invalidSlugs[slug] || 0) > Date.now()) return true;
  const p = campaignProgress && campaignProgress[slug];
  if (!p) return false;
  return !!(p.allComplete || p.expired);
}

// True only when we have a reasonably fresh /drops/campaigns snapshot that
// positively shows NO open campaign for this game - never on missing or
// stale data (fail open), and never overriding a per-game campaign
// annotation that already says one is open.
function lacksOpenCampaign(game, openCampaigns) {
  if (!openCampaigns || !openCampaigns.bySlug || !openCampaigns.fetchedAt) return false;
  // an empty snapshot is a failed/partial capture, not "Twitch has no
  // campaigns" - a real one always lists 100+ - so don't act on it
  if (Object.keys(openCampaigns.bySlug).length === 0) return false;
  if (Date.now() - openCampaigns.fetchedAt > OPEN_CAMPAIGNS_MAX_AGE_MS) return false;
  if (game.campaign && game.campaign.open) return false;
  const entry = openCampaigns.bySlug[game.slug];
  if (entry && entry.active) return false;
  return true;
}

async function tabExists(tabId) {
  if (!tabId) return false;
  try { await browser.tabs.get(tabId); return true; } catch { return false; }
}

// closes (if open) and removes the tab tracked for one game - mutates the
// passed-in watchTabs object in place, caller is responsible for persisting it
async function closeWatchTab(watchTabs, slug) {
  const tabId = watchTabs[slug];
  if (tabId) {
    try { await browser.tabs.remove(tabId); } catch { /* already closed by the user */ }
  }
  delete watchTabs[slug];
}

// list-order (default): original priority order, with any game currently in
// its "nobody live" cooldown pushed to the back.
// expiry: soonest-expiring-first among games with a known expiry date;
// unknown-expiry games fall back to list order and sort after the known
// ones - never guessed. The expiry date is Twitch's own campaign endAt
// (from the open-campaigns snapshot, known for every game that has an open
// campaign) when available, otherwise the inventory card's parsed "End
// Date" as a fallback.
function orderByPriority(games, mode, campaignProgress, emptyUntil) {
  const now = Date.now();
  const tagged = games.map((g, i) => ({
    g, i, cooling: (emptyUntil[g.slug] || 0) > now,
  }));

  if (mode === "expiry") {
    const withExpiry = tagged.map((x) => {
      const p = campaignProgress[x.g.slug];
      const fromCampaign = x.g.campaign && typeof x.g.campaign.endAt === "number" ? x.g.campaign.endAt : null;
      const fromInventory = p && typeof p.expiresAt === "number" ? p.expiresAt : null;
      const expiresAt = fromCampaign != null ? fromCampaign : fromInventory;
      return { ...x, expiresAt };
    });
    const known = withExpiry.filter((x) => x.expiresAt != null && !x.cooling)
      .sort((a, b) => a.expiresAt - b.expiresAt);
    const unknown = withExpiry.filter((x) => x.expiresAt == null && !x.cooling)
      .sort((a, b) => a.i - b.i);
    const cooling = withExpiry.filter((x) => x.cooling).sort((a, b) => a.i - b.i);
    return [...known, ...unknown, ...cooling].map((x) => x.g);
  }

  const active = tagged.filter((x) => !x.cooling).sort((a, b) => a.i - b.i);
  const cooling = tagged.filter((x) => x.cooling).sort((a, b) => a.i - b.i);
  return [...active, ...cooling].map((x) => x.g);
}

async function teardownAllWatch(reason) {
  const cfg = await browser.storage.local.get(["watchTabs", "watchPhase"]);
  const watchTabs = cfg.watchTabs || {};
  for (const tabId of Object.values(watchTabs)) {
    try { await browser.tabs.remove(tabId); } catch { /* already closed */ }
  }
  if (cfg.watchPhase !== "idle") {
    await browser.storage.local.set({ watchTabs: {}, watchPhase: "idle", watchMeta: {}, dropSignals: {} });
  }
  log("auto-watch idle:", reason);
  await refreshBadge();
}

async function finishAllDone() {
  const cfg = await browser.storage.local.get(["watchPhase", "watchTabs"]);
  if (cfg.watchPhase === "all-done") return; // already handled
  const watchTabs = cfg.watchTabs || {};
  log("every tracked game is fully collected - closing all watch tabs");
  for (const tabId of Object.values(watchTabs)) {
    try { await browser.tabs.remove(tabId); } catch { /* already closed */ }
  }
  await browser.storage.local.set({ watchTabs: {}, watchPhase: "all-done", watchMeta: {}, dropSignals: {} });
  await refreshBadge();
  // if the user asked for it, switch the whole extension off now that every
  // tracked game is collected - nothing more for it to do until they change
  // the list (see checkAutoOff)
  await checkAutoOff();
}

// the core scheduler - not self-serializing, callers must go through
// serialized(autoWatchTick)
async function autoWatchTick() {
  const cfg = await browser.storage.local.get([
    "enabled", "autoWatchEnabled", "watchList", "invalidSlugs", "campaignProgress",
    "watchTabs", "tabQuota", "priorityMode", "emptyUntil", "watchMeta", "dropSignals",
    "gameWaitUntil", "openCampaigns",
  ]);
  if (!cfg.enabled || !cfg.autoWatchEnabled) return;

  const list = cfg.watchList || [];
  if (list.length === 0) {
    await teardownAllWatch("no games in list");
    return;
  }

  // keep the open-campaign snapshot fresh so "this game has no campaign" and
  // the canonical-name resolution don't drift - fire and forget, the
  // in-flight guard stops this from opening more than one tab at a time
  const oc = cfg.openCampaigns;
  if (!oc || !oc.fetchedAt || Date.now() - oc.fetchedAt > OPEN_CAMPAIGNS_REFRESH_MS) {
    refreshOpenCampaigns({ maxAgeMs: OPEN_CAMPAIGNS_REFRESH_MS })
      .then(annotateWatchListFromCampaigns)
      .catch(() => {});
  }

  const invalidSlugs = cfg.invalidSlugs || [];
  const campaignProgress = cfg.campaignProgress || {};
  const emptyUntil = cfg.emptyUntil || {};
  const gameWaitUntil = cfg.gameWaitUntil || {};
  const quota = Math.max(1, cfg.tabQuota || DEFAULT_TAB_QUOTA);
  const priorityMode = cfg.priorityMode === "expiry" ? "expiry" : "list-order";
  let watchTabs = { ...(cfg.watchTabs || {}) };
  let watchMeta = { ...(cfg.watchMeta || {}) };
  let dropSignals = { ...(cfg.dropSignals || {}) };

  const now = Date.now();
  const eligible = list.filter((g) =>
    !isGameDone(g.slug, campaignProgress, invalidSlugs) &&
    !((gameWaitUntil[g.slug] || 0) > now) &&
    !lacksOpenCampaign(g, cfg.openCampaigns)
  );

  if (eligible.length === 0) {
    // nothing to watch right now - but this can be purely "every game is
    // waiting on a start date / has no open campaign yet", which is not the
    // same as "all done". Only call it done when at least one game is
    // genuinely finished/expired and none are merely waiting.
    const anyWaiting = list.some((g) =>
      (gameWaitUntil[g.slug] || 0) > now || lacksOpenCampaign(g, cfg.openCampaigns)
    );
    if (anyWaiting) {
      await teardownAllWatch("all games waiting on a start date / open campaign");
    } else {
      await finishAllDone();
    }
    return;
  }

  // drop tabs for games that are no longer eligible (done, invalid, or
  // removed from the list) - every other game's tab is untouched
  const eligibleSlugs = new Set(eligible.map((g) => g.slug));
  for (const slug of Object.keys(watchTabs)) {
    if (!eligibleSlugs.has(slug)) {
      await closeWatchTab(watchTabs, slug);
      delete watchMeta[slug];
      delete dropSignals[slug];
    }
  }

  // drop bookkeeping for tabs the user closed manually
  for (const slug of Object.keys(watchTabs)) {
    if (!(await tabExists(watchTabs[slug]))) delete watchTabs[slug];
  }

  // fill remaining quota with the next-priority eligible games not already watched
  const ordered = orderByPriority(eligible, priorityMode, campaignProgress, emptyUntil);
  let openCount = Object.keys(watchTabs).length;
  for (const game of ordered) {
    if (openCount >= quota) break;
    if (watchTabs[game.slug]) continue; // already has a tab

    const { id: watchWindowId } = await getOrCreateWatchWindow();
    const tab = await browser.tabs.create({ url: directoryUrl(game.slug), active: false, pinned: true, ...(watchWindowId ? { windowId: watchWindowId } : {}) });
    await browser.tabs.update(tab.id, { active: false, muted: true });
    watchTabs[game.slug] = tab.id;
    openCount++;
    log("opened watch tab for", game.slug, `tab=${tab.id}`, `(${openCount}/${quota})`);
  }

  await browser.storage.local.set({ watchTabs, watchPhase: "watching", watchMeta, dropSignals });
  await refreshBadge();
}

async function handleDirectoryInvalid(slug, actualPathname, actualHref) {
  return serialized(async () => {
    const cfg = await browser.storage.local.get(["invalidSlugs", "watchTabs"]);
    // invalidSlugs is slug -> retry-after timestamp (was a permanent array
    // until INVALID_SLUG_RETRY_MS was added - see its comment); tolerate
    // old array-shaped data left over from before that change by just
    // ignoring it rather than crashing on it.
    const prevInvalidSlugs = cfg.invalidSlugs;
    const invalidSlugs = { ...(prevInvalidSlugs && !Array.isArray(prevInvalidSlugs) ? prevInvalidSlugs : {}) };
    invalidSlugs[slug] = Date.now() + INVALID_SLUG_RETRY_MS;
    const watchTabs = { ...(cfg.watchTabs || {}) };
    await closeWatchTab(watchTabs, slug);
    await browser.storage.local.set({ invalidSlugs, watchTabs });
    log(
      "slug looks invalid (directory redirected away), retrying automatically in",
      Math.round(INVALID_SLUG_RETRY_MS / 60000), "min:", slug,
      "- landed on", actualPathname || "(unknown)", actualHref ? `(${actualHref})` : ""
    );
    await autoWatchTick();
  });
}

async function handleDirectoryEmpty(slug) {
  return serialized(async () => {
    const cfg = await browser.storage.local.get(["watchTabs", "emptyUntil"]);
    const watchTabs = { ...(cfg.watchTabs || {}) };
    await closeWatchTab(watchTabs, slug);
    const emptyUntil = { ...(cfg.emptyUntil || {}) };
    emptyUntil[slug] = Date.now() + EMPTY_COOLDOWN_MS;
    await browser.storage.local.set({ watchTabs, emptyUntil });
    log("no live channels for", slug, "- freed its slot for", Math.round(EMPTY_COOLDOWN_MS / 60000), "min");
    await autoWatchTick();
  });
}

// ============================================================================
// slug resolution via Twitch search  (permanent fix for "wrong guessed slug")
// ============================================================================
// content.js's directory-page check found a slug that renders a blank
// unknown-category page (no redirect, no <h1>/title - see
// looksLikeUnknownCategory). Rather than just parking it, look up the real
// directory slug from Twitch's own search results: content.js scrapes the
// `a[data-a-target="search-result-category"]` link (a stable selector, and
// its href carries the canonical slug even when the game's display name no
// longer matches it) on the /search page and posts `searchCategoryResult`.
// On success the watch-list slug is corrected in place and cached in
// `gameSlugMap` so it's a one-time cost per game; on failure it falls back
// to the normal invalid-slug retry cooldown.

// normalizeGameName(term) -> resolve(slug) for an in-flight search lookup
const pendingSlugResolves = new Map();

function handleSearchCategoryResult(msg) {
  if (!msg || !msg.term || !msg.slug) return;
  const resolver = pendingSlugResolves.get(normalizeGameName(msg.term));
  if (resolver) resolver(msg.slug);
}

async function handleDirectoryUnknownCategory(msg) {
  const badSlug = msg.slug;
  if (!badSlug) return;

  // park the dud slug briefly so autoWatchTick doesn't reopen its tab while
  // the search runs (extended to the full retry window, or cleared, below)
  await serialized(async () => {
    const cfg = await browser.storage.local.get(["invalidSlugs", "watchTabs"]);
    const invalidSlugs = { ...(cfg.invalidSlugs && !Array.isArray(cfg.invalidSlugs) ? cfg.invalidSlugs : {}) };
    invalidSlugs[badSlug] = Date.now() + 3 * 60 * 1000;
    const watchTabs = { ...(cfg.watchTabs || {}) };
    await closeWatchTab(watchTabs, badSlug);
    await browser.storage.local.set({ invalidSlugs, watchTabs });
  });
  await serialized(autoWatchTick);

  let gameName = msg.gameName;
  if (!gameName) {
    const { watchList } = await browser.storage.local.get("watchList");
    const g = (watchList || []).find((x) => x.slug === badSlug);
    gameName = g && (g.displayName || g.input);
  }
  if (!gameName) {
    log("unknown category for", badSlug, "- no game name to search with, leaving it parked");
    return;
  }

  const key = normalizeGameName(gameName);
  let searchTab = null;
  const found = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 25_000);
    pendingSlugResolves.set(key, (slug) => { clearTimeout(timer); resolve(slug); });
    getOrCreateWatchWindow()
      .then(({ id: watchWindowId }) => browser.tabs.create({ url: searchUrl(gameName), active: false, pinned: true, ...(watchWindowId ? { windowId: watchWindowId } : {}) }))
      .then((t) => { searchTab = t; })
      .catch((e) => { clearTimeout(timer); log("slug-resolve: could not open search tab:", e); resolve(null); });
  });
  pendingSlugResolves.delete(key);
  if (searchTab) { try { await browser.tabs.remove(searchTab.id); } catch { /* gone */ } }

  if (found && found !== badSlug) {
    log("resolved real category slug for", JSON.stringify(gameName), ":", badSlug, "->", found);
    await applyResolvedSlug(badSlug, found);
  } else {
    log("search could not resolve a real slug for", JSON.stringify(gameName), "- keeping", badSlug, "parked for the normal retry window");
    await handleDirectoryInvalid(badSlug, "(unknown category; search resolution failed)", null);
  }
}

// swap a wrong slug for the resolved one everywhere it's keyed, cache it in
// gameSlugMap so future openCampaigns snapshots get it right first time, and
// re-run the scheduler so the directory tab reopens with the correct slug.
async function applyResolvedSlug(badSlug, goodSlug) {
  await serialized(async () => {
    const cfg = await browser.storage.local.get([
      "watchList", "invalidSlugs", "emptyUntil", "gameWaitUntil",
      "campaignProgress", "gameSlugMap", "watchTabs", "openCampaigns",
    ]);
    const watchList = (cfg.watchList || []).map(
      (g) => (g.slug === badSlug ? { ...g, slug: goodSlug } : g)
    );

    const rekey = (obj) => {
      if (!obj || typeof obj !== "object" || Array.isArray(obj) || !(badSlug in obj)) return obj || {};
      const next = { ...obj, [goodSlug]: obj[badSlug] };
      delete next[badSlug];
      return next;
    };
    const invalidSlugs = rekey(cfg.invalidSlugs && !Array.isArray(cfg.invalidSlugs) ? cfg.invalidSlugs : {});
    delete invalidSlugs[goodSlug]; // resolved - retry now, don't sit in cooldown
    const emptyUntil = rekey(cfg.emptyUntil || {});
    delete emptyUntil[goodSlug];
    const gameWaitUntil = rekey(cfg.gameWaitUntil || {});
    const campaignProgress = rekey(cfg.campaignProgress || {});

    const gameSlugMap = { ...(cfg.gameSlugMap || {}) };
    const ocEntry = cfg.openCampaigns && cfg.openCampaigns.bySlug &&
      (cfg.openCampaigns.bySlug[badSlug] || cfg.openCampaigns.bySlug[goodSlug]);
    const gid = (ocEntry && ocEntry.gameId) ||
      ((cfg.watchList || []).find((g) => g.slug === badSlug || g.slug === goodSlug) || {}).gameId;
    if (gid) gameSlugMap[gid] = goodSlug;

    const watchTabs = { ...(cfg.watchTabs || {}) };
    await closeWatchTab(watchTabs, badSlug);

    suppressWatchListReaction = true;
    try {
      await browser.storage.local.set({
        watchList, invalidSlugs, emptyUntil, gameWaitUntil, campaignProgress, gameSlugMap, watchTabs,
      });
    } finally {
      suppressWatchListReaction = false;
    }
  });
  await serialized(autoWatchTick);
}

async function mergeInventoryProgress(campaigns) {
  // campaigns may legitimately be [] (every watched game's card is gone from
  // "In Progress") - still need to run so the missing-card reconciliation
  // below gets a chance to fire. Only a genuinely missing/malformed message
  // short-circuits.
  if (!campaigns) return;

  return serialized(async () => {
    const cfg = await browser.storage.local.get([
      "campaignProgress", "watchTabs", "watchMeta", "dropSignals", "gameIdMap", "gameActiveIds", "watchList",
    ]);
    const progress = cfg.campaignProgress || {};
    const watchTabs = { ...(cfg.watchTabs || {}) };
    const watchMeta = { ...(cfg.watchMeta || {}) };
    const dropSignals = { ...(cfg.dropSignals || {}) };
    const watchList = cfg.watchList || [];
    let anyJustFinished = false;

    // GQL's own campaign.status ("ACTIVE"/"EXPIRED", learned alongside
    // gameIdMap - see inject.js's Inventory extractor) is a more reliable
    // "is there still a live campaign for this game" check than content.js's
    // DOM text scrape, which has no way to disambiguate when a game shows
    // more than one campaign card at once (an old, past-end-date one
    // alongside a current one) - real capture caught exactly that for
    // marvel-rivals. Build slug -> confirmed-still-active once per merge.
    const gameIdMap = cfg.gameIdMap || {};
    const gameActiveIds = cfg.gameActiveIds || {};
    const activeSlugs = new Set();
    for (const [id, name] of Object.entries(gameIdMap)) {
      if (gameActiveIds[id]) activeSlugs.add(toSlug(name));
    }

    for (const c of campaigns) {
      const allComplete = c.total > 0 && c.claimed >= c.total && !c.accountNotConnected;
      const expired = !!c.expired && !activeSlugs.has(c.slug);
      progress[c.slug] = {
        label: c.label,
        claimed: c.claimed,
        total: c.total,
        accountNotConnected: !!c.accountNotConnected,
        expired,
        allComplete,
        expiresAt: typeof c.expiresAt === "number" ? c.expiresAt : null,
        timeRemainingMin: c.timeRemainingMin ?? null,
        updatedAt: Date.now(),
        missingScans: 0,
      };
      if ((allComplete || expired) && watchTabs[c.slug]) {
        await closeWatchTab(watchTabs, c.slug);
        delete watchMeta[c.slug];
        delete dropSignals[c.slug];
        anyJustFinished = true;
        log(c.slug, allComplete ? "fully claimed" : "expired", "- closed its tab");
      }
    }

    // Reconcile watched games whose card wasn't in this scan at all. Only
    // acts on a slug that: is still on the watch list, has a prior reading
    // with real progress (total > 0 - never invent completion for a game we
    // never actually saw a card for), and isn't already resolved. See
    // REQUIRED_MISSING_SCANS above for why this waits for corroboration
    // instead of acting on the first miss.
    const seenSlugs = new Set(campaigns.map((c) => c.slug));
    for (const game of watchList) {
      const slug = game.slug;
      if (seenSlugs.has(slug)) continue;
      const p = progress[slug];
      if (!p || p.allComplete || p.expired || !(p.total > 0)) continue;

      const missingScans = (p.missingScans || 0) + 1;
      if (missingScans >= REQUIRED_MISSING_SCANS) {
        progress[slug] = { ...p, allComplete: true, missingScans: 0, updatedAt: Date.now() };
        if (watchTabs[slug]) {
          await closeWatchTab(watchTabs, slug);
          delete watchMeta[slug];
          delete dropSignals[slug];
          anyJustFinished = true;
        }
        log(slug, "card vanished from In Progress across", missingScans, "scans - treating as fully claimed");
      } else {
        progress[slug] = { ...p, missingScans };
      }
    }

    await browser.storage.local.set({ campaignProgress: progress, watchTabs, watchMeta, dropSignals });
    if (anyJustFinished) await autoWatchTick();
  });
}

// ============================================================================
// drop-status verification - catches "fake category" streams: a channel
// listed under a game's drops-filtered directory that isn't actually
// broadcasting with that game's drop campaign attached, so watching it
// never accrues progress.
//
// Signal source: campaignProgress[slug], the same data content.js already
// scrapes from the /drops/inventory page's DOM for the auto-skip logic
// (mergeInventoryProgress() above) - specifically .claimed (reward tiers
// fully claimed) and .timeRemainingMin (best-effort parse of Twitch's own
// "N min left" text, see extractRemainingMinutes() in content.js). A
// baseline of both is captured the first time a fresh-enough reading is
// seen after switching to a channel; on a later sweep, once VERIFY_DELAY_MS
// has passed AND a newer reading than the baseline has come in, neither
// number having moved is treated as "not crediting us" and the channel gets
// rotated. If neither number is usable at all (timeRemainingMin never
// parsed and claimed never moved) that's "can't tell", not "it's stuck" -
// fails closed to keep watching rather than risk rejecting a channel that's
// actually fine.
//
// This intentionally does NOT use gql-bridge.js/inject.js's channel-tab GQL
// sniffing (dropSignals) - see the top-of-file comment for why that data
// source turned out to be a dead end for a background/pinned watch tab.
//
// Already-claimed campaigns are NOT this function's job: mergeInventoryProgress
// / isGameDone already close a game's tab the moment its campaign is fully
// claimed or expired. verifyDropStatus only runs for games still eligible
// and currently on a channel, and only ever *rotates* the channel - it never
// removes a game from the watch list.
//
// rejectChannel() is deliberately the ONLY place that blocklists a channel -
// see the top-of-file comment on why content.js's DOM offline/raid check
// (handleChannelLeft below) must not do this on its own.
// ============================================================================
async function rejectChannel(slug, channelName, tabId) {
  const cfg = await browser.storage.local.get(["blockedChannels", "watchMeta", "dropSignals"]);
  const blockedChannels = { ...(cfg.blockedChannels || {}) };
  const forSlug = { ...(blockedChannels[slug] || {}) };
  forSlug[(channelName || "").toLowerCase()] = Date.now() + CHANNEL_BLOCK_COOLDOWN_MS;
  blockedChannels[slug] = forSlug;

  const watchMeta = { ...(cfg.watchMeta || {}) };
  delete watchMeta[slug];
  const dropSignals = { ...(cfg.dropSignals || {}) };
  delete dropSignals[slug];

  await browser.storage.local.set({ blockedChannels, watchMeta, dropSignals });
  maybeAutoExportDebugLog();

  try {
    // same tab, bounced back to the directory - cheaper than closing and
    // reopening, and content.js's existing directory-page picker takes it
    // from here (it will read blockedChannels back via isWatchTab and skip
    // this channel on the re-pick).
    await browser.tabs.update(tabId, { url: directoryUrl(slug), active: false });
  } catch (e) {
    log("rejectChannel: tab already gone for", slug, e);
  }
}

async function verifyDropStatus(slug) {
  const cfg = await browser.storage.local.get(["watchTabs", "watchMeta", "campaignProgress"]);
  const tabId = (cfg.watchTabs || {})[slug];
  const meta = (cfg.watchMeta || {})[slug];
  if (!tabId || !meta) return; // no tab, or no channel picked yet for it

  const progress = (cfg.campaignProgress || {})[slug];
  if (progress && (progress.allComplete || progress.expired)) return; // autoWatchTick handles closing this tab

  // No inventory reading at all yet since this channel started - fail
  // closed (can't judge on nothing), whether that's because the inventory
  // tab hasn't scanned yet or this game isn't showing on that page at all.
  if (!progress || !progress.updatedAt || progress.updatedAt < meta.watchStartedAt) {
    log("[verify]", slug, "channel", meta.channel, "- no fresh inventory reading yet since this channel started, waiting");
    return;
  }

  // First fresh-enough reading since this channel started: record it as the
  // baseline and judge on a later sweep, rather than comparing against a
  // stale number left over from a previous channel.
  if (meta.baselineCapturedAt == null) {
    const watchMeta = { ...(cfg.watchMeta || {}) };
    watchMeta[slug] = {
      ...meta,
      baselineCapturedAt: Date.now(),
      baselineClaimed: progress.claimed,
      baselineTimeRemainingMin: progress.timeRemainingMin,
    };
    await browser.storage.local.set({ watchMeta });
    log(
      "[verify]", slug, "channel", meta.channel, "- baseline captured:",
      `claimed=${progress.claimed}`, `timeRemainingMin=${progress.timeRemainingMin}`
    );
    return;
  }

  // Gated on time-since-*this*-baseline, not time-since-watchStartedAt -
  // this is what makes verification a repeating rolling check instead of a
  // one-shot: once a window's judgment re-baselines below (the "progressing"
  // branch), the very next window starts counting from that fresh point,
  // so a channel doesn't become permanently exempt from ever being
  // re-checked again just because it passed once.
  const elapsedSinceBaseline = Date.now() - meta.baselineCapturedAt;
  if (elapsedSinceBaseline < VERIFY_DELAY_MS) {
    log(
      "[verify]", slug, "channel", meta.channel, "- waiting,",
      Math.round(elapsedSinceBaseline / 1000), "/", Math.round(VERIFY_DELAY_MS / 1000), "s since baseline"
    );
    return;
  }
  if (progress.updatedAt <= meta.baselineCapturedAt) {
    log("[verify]", slug, "channel", meta.channel, "- verify window elapsed but no reading newer than the baseline yet, waiting");
    return;
  }

  const claimedMoved = progress.claimed > meta.baselineClaimed;
  const timeMoved =
    meta.baselineTimeRemainingMin != null &&
    progress.timeRemainingMin != null &&
    progress.timeRemainingMin < meta.baselineTimeRemainingMin;

  if (claimedMoved || timeMoved) {
    // Progressing - re-baseline against *this* reading instead of just
    // returning and leaving the old baseline in place. Comparing every
    // future window against a stale, ever-further-in-the-past baseline
    // would mean "moved at all since the very first reading" stays true
    // forever even after the channel stops crediting entirely (e.g. goes
    // offline) - this bug is exactly why a real offline channel sat
    // un-rotated for an entire overnight run instead of being caught
    // within one VERIFY_DELAY_MS window. See HISTORY.md.
    log(
      "[verify]", slug, "channel", meta.channel, "- progressing, re-baselining:",
      `claimed ${meta.baselineClaimed} -> ${progress.claimed},`,
      `timeRemainingMin ${meta.baselineTimeRemainingMin} -> ${progress.timeRemainingMin}`
    );
    const watchMeta = { ...(cfg.watchMeta || {}) };
    watchMeta[slug] = {
      ...meta,
      baselineCapturedAt: Date.now(),
      baselineClaimed: progress.claimed,
      baselineTimeRemainingMin: progress.timeRemainingMin,
    };
    await browser.storage.local.set({ watchMeta });
    return;
  }

  if (meta.baselineTimeRemainingMin == null && progress.timeRemainingMin == null) {
    // never got a usable timeRemainingMin reading at all for this campaign
    // (DOM parsing probably isn't matching this card's text - best-effort,
    // see extractRemainingMinutes in content.js) and reward-tier completion
    // is too coarse a signal to trust alone this early - can't tell, so
    // fail closed rather than risk rejecting a channel that's actually fine
    log("[verify]", slug, "channel", meta.channel, "- no usable timeRemainingMin signal at all, can't tell, keeping watching (fail closed)");
    return;
  }

  log(
    "[verify]", slug, "channel", meta.channel, "- no progress for a full verify window",
    `(claimed ${meta.baselineClaimed} -> ${progress.claimed},`,
    `timeRemainingMin ${meta.baselineTimeRemainingMin} -> ${progress.timeRemainingMin})`,
    "- flagged stalled"
  );
  return { stalled: true, channelName: meta.channel, tabId };
}

// Every slug reaching a stalled verdict in the SAME sweep - with 2+ slugs
// actually judged - points at a system-wide cause (network/GPU/OS hiccup,
// e.g. the display-power-off/window-occlusion interaction reported
// 2026-09-04: Windows turning the monitor off is not sleep, but Firefox's
// window-occlusion tracking can still treat every window as invisible and
// suspend background video, which would stall every watched channel at
// once) rather than any one channel actually going bad. rejectChannel()
// blocklists by channel NAME, so blindly rejecting every slug in that
// situation would fill blockedChannels with channels that were fine,
// working through them one sweep at a time until nothing usable is left.
// Only reject when it's not unanimous - a single stalled slug alongside
// others still progressing normally is real evidence against that one
// channel specifically.
async function verifySweep() {
  const cfg = await browser.storage.local.get(["watchMeta"]);
  const slugs = Object.keys(cfg.watchMeta || {});
  const verdicts = [];
  for (const slug of slugs) {
    const verdict = await verifyDropStatus(slug);
    if (verdict) verdicts.push({ slug, ...verdict });
  }

  const allStalledTogether = verdicts.length >= 2 && verdicts.every((v) => v.stalled);
  if (allStalledTogether) {
    log(
      "[verify] all", verdicts.length, "watched channels stalled in the same sweep",
      `(${verdicts.map((v) => v.slug).join(", ")})`,
      "- treating as a system-wide cause, not rotating any of them this sweep"
    );
    return;
  }

  for (const v of verdicts) {
    if (v.stalled) await rejectChannel(v.slug, v.channelName, v.tabId);
  }
}

// How long a freshly-picked watch tab is briefly brought to the foreground
// of the dedicated watch window (getOrCreateWatchWindow above) so Twitch's
// own player actually starts. Live RDP capture (2026-09-04) found
// video.readyState/currentTime stuck at 0 indefinitely without this on some
// channels - Twitch's player never issues the PlaybackAccessToken/usher
// fetch for a tab that has never been the active tab of its window. Only
// ever called after confirming (via tab.windowId, in the caller) the tab is
// actually inside the isolated watch window - never anywhere the user could
// be looking. holdMs is a parameter (not just the constant) purely so tests
// can exercise the revert without a real 8s wait.
const PLAYBACK_FLASH_HOLD_MS = 8_000;
async function flashTabToStartPlayback(tabId, holdMs = PLAYBACK_FLASH_HOLD_MS) {
  try {
    await browser.tabs.update(tabId, { active: true });
  } catch (e) {
    log("flashTabToStartPlayback: could not activate tab", tabId, e);
    return;
  }
  setTimeout(async () => {
    try {
      await browser.tabs.update(tabId, { active: false });
    } catch {
      // tab already gone/rotated away - nothing to revert
    }
  }, holdMs);
}

async function handleDirectoryPicked(slug, channel, tab) {
  return serialized(async () => {
    if (!tab) return;
    const cfg = await browser.storage.local.get(["watchTabs", "watchMeta", "dropSignals"]);
    if ((cfg.watchTabs || {})[slug] !== tab.id) return; // stale message from a tab no longer tracked for this slug

    const watchMeta = { ...(cfg.watchMeta || {}) };
    const dropSignals = { ...(cfg.dropSignals || {}) };
    const prev = watchMeta[slug];
    let freshChannel = false;

    if (prev && prev.channel === channel) {
      // Same channel re-picked - happens when content.js's DOM offline/raid
      // check (handleChannelLeft below) bounces the tab to the directory
      // but Twitch's own listing hasn't dropped this channel yet, so
      // pickBestChannel() re-selects it. Deliberately keep the existing
      // watchStartedAt/baseline going rather than resetting the verify
      // clock: only verifyDropStatus's campaign-progress comparison may
      // decide to reject a channel (see the top-of-file comment) - if this
      // reset on every re-pick, a channel that keeps getting re-picked
      // before the listing catches up would never accumulate enough
      // elapsed time for that check to ever fire, and would sit there
      // indefinitely instead of eventually rotating.
      log("watch tab for", slug, `tab=${tab.id}`, "re-picked the same channel", channel, "- keeping existing verify clock");
    } else {
      watchMeta[slug] = { channel, tabId: tab.id, watchStartedAt: Date.now() };
      delete dropSignals[slug]; // fresh channel, fresh signals
      freshChannel = true;
      log("watch tab for", slug, `tab=${tab.id}`, "now on channel", channel);
    }

    await browser.storage.local.set({ watchMeta, dropSignals });

    if (freshChannel) {
      // fire-and-forget - never block picking the channel on this
      (async () => {
        const { id: watchWindowId } = await getOrCreateWatchWindow();
        if (watchWindowId == null) return; // no isolated window - never flash in the user's own
        try {
          const liveTab = await browser.tabs.get(tab.id);
          if (liveTab.windowId === watchWindowId) await flashTabToStartPlayback(tab.id);
        } catch {
          // tab already gone
        }
      })();
    }
  });
}

// content.js's own DOM offline/raid check already navigates its own tab
// back to the directory immediately on its own (see content.js,
// looksLive()/looksOffline(), a same-tab location.href - not a
// WebExtension action, so it's not something this file commands or could
// prevent even if it wanted to). This handler is deliberately NOT allowed
// to reject/blocklist the channel or touch watchMeta/dropSignals on its
// own - see the top-of-file comment on why: that decision belongs solely
// to verifyDropStatus's campaign-progress comparison. Left as a log-only
// hint. watchMeta is deliberately left untouched here so
// handleDirectoryPicked's same-channel re-pick handling (above) can keep
// the verify clock running across any bounce this DOM check causes.
async function handleChannelLeft(slug) {
  if (!slug) return;
  log(slug, "- DOM check reported offline/redirected (informational only, does not reject the channel)");
}

// Exception to the rule above: an offline channel, or one whose own stream
// info now names a different game, is confirmed twice by content.js
// (channelProblem(), 10s apart) and is unambiguous, not a heuristic - and the
// tab is already on its way back to the directory, where Twitch's listing
// often still shows the channel for a while and pickBestChannel() would
// re-pick it. So it only gets a short block (not rejectChannel's 45 min, and
// watchMeta/dropSignals stay untouched).
async function handleChannelUnusable(msg) {
  const { slug, channel, reason } = msg;
  if (!slug || !channel) return;
  return serialized(async () => {
    const cfg = await browser.storage.local.get(["blockedChannels"]);
    const blockedChannels = { ...(cfg.blockedChannels || {}) };
    blockedChannels[slug] = {
      ...(blockedChannels[slug] || {}),
      [channel.toLowerCase()]: Date.now() + UNUSABLE_CHANNEL_COOLDOWN_MS,
    };
    await browser.storage.local.set({ blockedChannels });
    log(slug, "- channel", channel, "unusable (" + reason + "), skipped for", UNUSABLE_CHANNEL_COOLDOWN_MS / 60000, "min");
    maybeAutoExportDebugLog();
  });
}

async function handleGqlDropSignal(msg, tab) {
  if (!tab) return;

  // openCampaigns is a full snapshot of every drop campaign Twitch currently
  // lists (from the transient /drops/campaigns tab, see refreshOpenCampaigns)
  // - account-wide, not tied to a watch tab, so handled before the slug-gate.
  // id -> real category slug, learned from SideNav (which carries id + slug
  // together). Global, not tab-scoped - handled before the slug gate.
  if (msg.signal.kind === "gameSlugs") {
    return serialized(async () => {
      const cfg = await browser.storage.local.get(["gameSlugMap", "gameIdMap"]);
      const gameSlugMap = { ...(cfg.gameSlugMap || {}) };
      const gameIdMap = { ...(cfg.gameIdMap || {}) };
      let changed = false;
      for (const g of msg.signal.games) {
        if (g.slug && gameSlugMap[g.id] !== g.slug) { gameSlugMap[g.id] = g.slug; changed = true; }
        if (g.name && gameIdMap[g.id] !== g.name) { gameIdMap[g.id] = g.name; changed = true; }
      }
      if (changed) await browser.storage.local.set({ gameSlugMap, gameIdMap });
    });
  }

  if (msg.signal.kind === "openCampaigns") {
    await serialized(async () => {
      const cfg = await browser.storage.local.get(["gameIdMap", "gameSlugMap"]);
      const gameIdMap = { ...(cfg.gameIdMap || {}) };
      for (const g of msg.signal.games) {
        if (g.id && g.name && gameIdMap[String(g.id)] !== g.name) gameIdMap[String(g.id)] = g.name;
      }
      const bySlug = buildOpenCampaignsSnapshot(msg.signal.games, cfg.gameSlugMap || {});
      await browser.storage.local.set({
        gameIdMap,
        openCampaigns: { fetchedAt: Date.now(), bySlug },
      });
      const activeCount = Object.values(bySlug).filter((c) => c.active).length;
      log("[openCampaigns] snapshot:", Object.keys(bySlug).length, "games,", activeCount, "with an open campaign");
    });
    notifyCampaignsSignal();
    // not inside the serialized block above - annotateWatchListFromCampaigns
    // runs its own serialized units (see its comment)
    await annotateWatchListFromCampaigns();
    return;
  }

  // gameIds is global (game.id -> game.name), not tied to any particular
  // watch tab/slug - deliberately handled before the slug-gate below, which
  // would otherwise drop it whenever it comes from a tab that isn't
  // currently one of our own watch tabs (which, so far, is the only place
  // it's actually been observed - see inject.js's top-of-file comment).
  if (msg.signal.kind === "gameIds") {
    return serialized(async () => {
      const cfg = await browser.storage.local.get(["gameIdMap", "gameActiveIds"]);
      const gameIdMap = { ...(cfg.gameIdMap || {}) };
      const gameActiveIds = { ...(cfg.gameActiveIds || {}) };
      let changed = false;
      for (const g of msg.signal.games) {
        if (gameIdMap[g.id] !== g.name) {
          gameIdMap[g.id] = g.name;
          changed = true;
        }
      }
      // active is only present on extractors that actually carry Twitch's
      // own campaign.status (currently just Inventory - see inject.js);
      // OR within this one batch so a game with both an active and an
      // expired campaign card still counts as active. Each fresh batch
      // fully replaces the previous verdict for the ids it mentions (not
      // sticky-true-forever) so a game that later truly finishes for good
      // still becomes correctly detectable as done.
      const activeThisBatch = {};
      for (const g of msg.signal.games) {
        if (g.active === undefined) continue;
        activeThisBatch[g.id] = activeThisBatch[g.id] || !!g.active;
      }
      for (const [id, active] of Object.entries(activeThisBatch)) {
        if (gameActiveIds[id] !== active) {
          gameActiveIds[id] = active;
          changed = true;
        }
      }
      if (changed) {
        await browser.storage.local.set({ gameIdMap, gameActiveIds });
        log("[gameIdMap] learned:", msg.signal.games.map((g) => `${g.id}=${g.name}`).join(", "));
      }
    });
  }

  return serialized(async () => {
    const cfg = await browser.storage.local.get(["watchTabs", "dropSignals"]);
    const watchTabs = cfg.watchTabs || {};
    const slug = Object.keys(watchTabs).find((s) => watchTabs[s] === tab.id);
    if (!slug) return; // signal from a tab we're not tracking (e.g. the user's own browsing)

    const dropSignals = { ...(cfg.dropSignals || {}) };
    const entry = { ...(dropSignals[slug] || {}) };

    if (msg.signal.kind === "channelCampaigns") {
      entry.channelCampaigns = { campaignIds: msg.signal.campaignIds, at: msg.at };
    } else if (msg.signal.kind === "inventory") {
      // Inventory is account-wide, covering every in-progress campaign at
      // once - pick out the entry for the game this tab is watching by
      // matching its display name back to our slug (shared.js's toSlug is
      // already loaded in this context).
      const match = (msg.signal.campaigns || []).find(
        (c) => c.gameName && toSlug(c.gameName) === slug
      );
      if (match) {
        entry.latestMinutesWatched = match.minutesWatched;
        entry.latestMinutesAt = msg.at;
      }
    }

    dropSignals[slug] = entry;
    await browser.storage.local.set({ dropSignals });
  });
}

// ============================================================================
// alarms
// ============================================================================
async function applyEnabledState(enabled) {
  if (enabled) {
    browser.alarms.create(RELOAD_ALARM, { periodInMinutes: RELOAD_PERIOD_MIN });
    browser.alarms.create(AUTO_OFF_ALARM, { periodInMinutes: AUTO_OFF_PERIOD_MIN });
    browser.alarms.create(AUTO_WATCH_ALARM, { periodInMinutes: AUTO_WATCH_PERIOD_MIN });
    await serialized(openInventoryIfMissing);
    await serialized(autoWatchTick);
    refreshOpenCampaigns({ maxAgeMs: OPEN_CAMPAIGNS_REFRESH_MS })
      .then(annotateWatchListFromCampaigns)
      .catch(() => {});
  } else {
    await browser.alarms.clear(RELOAD_ALARM);
    await browser.alarms.clear(AUTO_OFF_ALARM);
    await browser.alarms.clear(AUTO_WATCH_ALARM);
    await teardownAllWatch("master switch off");
  }
  await refreshBadge();
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  const cfg = await browser.storage.local.get("enabled");
  if (!cfg.enabled) return;

  if (alarm.name === RELOAD_ALARM) {
    try {
      const tabs = await browser.tabs.query({ url: "*://www.twitch.tv/drops/inventory*" });
      if (tabs.length === 0) {
        await serialized(openInventoryIfMissing);
        return;
      }
      for (const tab of tabs) {
        if (!tab.active) {
          browser.tabs.reload(tab.id);
          log("reloaded inventory tab", tab.id);
        }
      }
    } catch (e) {
      log("reload failed:", e);
    }
    // same cadence as the inventory reload: keep the open-campaign snapshot
    // from going stale (only actually opens a tab once it's old enough)
    refreshOpenCampaigns({ maxAgeMs: OPEN_CAMPAIGNS_REFRESH_MS })
      .then(annotateWatchListFromCampaigns)
      .catch(() => {});
  } else if (alarm.name === AUTO_OFF_ALARM) {
    checkAutoOff();
  } else if (alarm.name === AUTO_WATCH_ALARM) {
    serialized(autoWatchTick);
    serialized(verifySweep);
  }
});

// ============================================================================
// messages from content scripts
// ============================================================================
browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "isWatchTab":
      return (async () => {
        const cfg = await browser.storage.local.get([
          "enabled", "autoWatchEnabled", "watchTabs", "watchList", "blockedChannels",
        ]);
        if (!cfg.enabled || !cfg.autoWatchEnabled || !sender.tab) {
          return { isWatchTab: false, activeGame: null, blockedChannels: [] };
        }
        const watchTabs = cfg.watchTabs || {};
        const slug = Object.keys(watchTabs).find((s) => watchTabs[s] === sender.tab.id);
        if (!slug) return { isWatchTab: false, activeGame: null, blockedChannels: [] };
        const game = (cfg.watchList || []).find((g) => g.slug === slug) || { slug, input: slug };
        const now = Date.now();
        const blockedForSlug = (cfg.blockedChannels || {})[slug] || {};
        const blockedChannels = Object.keys(blockedForSlug).filter((name) => blockedForSlug[name] > now);
        return { isWatchTab: true, activeGame: game, blockedChannels };
      })();

    case "directoryInvalid":
      return handleDirectoryInvalid(msg.slug, msg.actualPathname, msg.actualHref);

    case "directoryEmpty":
      return handleDirectoryEmpty(msg.slug);

    case "directoryUnknownCategory":
      return handleDirectoryUnknownCategory(msg);

    case "searchCategoryResult":
      return handleSearchCategoryResult(msg);

    // manual export button in popup.js - see exportDebugLogToFile() above
    case "exportDebugLog":
      return exportDebugLogToFile();

    case "directoryPicked":
      return handleDirectoryPicked(msg.slug, msg.channel, sender.tab);

    case "channelOffline":
    case "channelGameChanged":
      return handleChannelUnusable(msg);

    case "channelRedirected":
      return handleChannelLeft(msg.slug);

    case "gqlDropSignal":
      return handleGqlDropSignal(msg, sender.tab);

    case "inventoryProgress":
      return mergeInventoryProgress(msg.campaigns);

    case "dropClaimed":
      return handleDropClaimed();

    case "refreshCampaigns":
      // popup asked to re-check /drops/campaigns now
      return refreshOpenCampaigns()
        .then((oc) => annotateWatchListFromCampaigns().then(() => oc))
        .then((oc) => ({
          ok: !!(oc && oc.bySlug),
          fetchedAt: oc && oc.fetchedAt,
          total: oc && oc.bySlug ? Object.keys(oc.bySlug).length : 0,
          active: oc && oc.bySlug ? Object.values(oc.bySlug).filter((c) => c.active).length : 0,
        }))
        .catch((e) => ({ ok: false, error: String(e) }));

    default:
      return undefined;
  }
});

// ============================================================================
// react to relevant storage changes without needing a reload
// ============================================================================
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;

  if (changes.enabled) {
    const enabled = changes.enabled.newValue ?? true;
    if (enabled && !changes.enabled.oldValue) {
      // turned back on - drop the "auto-off: all collected" marker and the
      // stale all-done phase so the scheduler starts fresh
      await browser.storage.local.set({ enabledSince: Date.now(), completedAllAt: null, watchPhase: "idle" });
    }
    await applyEnabledState(enabled);
  }

  if (changes.autoWatchEnabled) {
    if (changes.autoWatchEnabled.newValue) {
      await serialized(autoWatchTick);
    } else {
      await teardownAllWatch("auto-watch turned off");
    }
  }

  if (changes.watchList && !suppressWatchListReaction) {
    const newList = changes.watchList.newValue || [];
    const slugs = new Set(newList.map((g) => g.slug));
    const cfg = await browser.storage.local.get(["invalidSlugs", "gameWaitUntil"]);
    const prevInvalidSlugs = cfg.invalidSlugs;
    const invalidSlugs = { ...(prevInvalidSlugs && !Array.isArray(prevInvalidSlugs) ? prevInvalidSlugs : {}) };
    for (const s of Object.keys(invalidSlugs)) {
      if (!slugs.has(s)) delete invalidSlugs[s];
    }
    // drop any manual wait-until date for a game that's no longer listed
    const gameWaitUntil = { ...(cfg.gameWaitUntil || {}) };
    let waitPruned = false;
    for (const s of Object.keys(gameWaitUntil)) {
      if (!slugs.has(s)) { delete gameWaitUntil[s]; waitPruned = true; }
    }
    await browser.storage.local.set(waitPruned ? { invalidSlugs, gameWaitUntil } : { invalidSlugs });
    await serialized(autoWatchTick);
    // re-resolve names / open-campaign status for the new list. The snapshot
    // is account-wide, so a recent one already covers a just-added game -
    // only re-open the /drops/campaigns tab if it's more than a few minutes
    // old. Not awaited, so the popup's save returns immediately.
    refreshOpenCampaigns({ maxAgeMs: 5 * 60 * 1000 })
      .then(annotateWatchListFromCampaigns)
      .catch((e) => log("campaign refresh after watchList change failed:", e));
  }

  if (changes.tabQuota || changes.priorityMode) {
    await serialized(autoWatchTick);
  }

  // popup's language picker writes uiLang - the toolbar tooltip is localized
  if (changes.uiLang) {
    await refreshBadge();
  }

  // popup's per-game "start watching from <date>" picker writes gameWaitUntil
  // directly - re-run the scheduler so a newly-set date pulls a tab now, and
  // a cleared/passed one lets the game back in
  if (changes.gameWaitUntil && !suppressWatchListReaction) {
    await serialized(autoWatchTick);
  }
});

// ---- runs when the background script loads (extension enabled / browser just started) ----
(async () => {
  const cfg = await browser.storage.local.get(["enabled", "enabledSince"]);
  const enabled = cfg.enabled ?? true;
  if (enabled && !cfg.enabledSince) {
    await browser.storage.local.set({ enabledSince: Date.now() });
  }
  await applyEnabledState(enabled);
})();
