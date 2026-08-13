/**
 * Twitch Drop Auto-Claimer - background script
 * (loaded after shared.js - toSlug/channelFromUrl/directoryUrl come from there)
 *
 * Two independent jobs:
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
 * Both are fully gated on the `enabled` flag in browser.storage.local -
 * once switched off, nothing here may open a tab, reload one, or fire a
 * request again. Auto-watch is additionally gated on `autoWatchEnabled`.
 *
 * Tab etiquette (verified below, not just assumed):
 *   - every tabs.create/tabs.update call below passes an explicit
 *     `active: false` - never omitted, never `true`.
 *   - muting is done at the browser level via tabs.update({muted:true})
 *     right after a watch tab is created - never by clicking Twitch's own
 *     mute button (that part was removed from content.js).
 *   - windows.update({focused:true}) is never called anywhere in this file.
 *   - content.js's own same-tab `location.href = ...` navigation (picking a
 *     channel from the directory, bouncing back to the directory on
 *     offline/raid) never changes tab activation - navigating a page's own
 *     location is not a WebExtension action and has no "active" concept, so
 *     a background tab navigating itself stays in the background. This is
 *     inherent browser behavior, not something this file needs to enforce.
 *   - a background window kept minimized was considered for a "separate
 *     window" mode, but is NOT implemented: whether Firefox keeps counting
 *     Twitch watch-time for a fully minimized window (as opposed to a
 *     background tab in a visible window, which is what this extension
 *     already relies on) could not be verified without hours of live
 *     watching on a real, logged-in Twitch account with an active Drops
 *     campaign - not something this environment can do. Rather than ship an
 *     option that might silently not work, only "current window" mode
 *     exists. If you test it yourself and confirm minimized windows still
 *     accrue watch time, this is the place to add it.
 */

const RELOAD_ALARM = "reload-inventory";
const RELOAD_PERIOD_MIN = 15;
const AUTO_OFF_ALARM = "auto-off-check";
const AUTO_OFF_PERIOD_MIN = 10;
const AUTO_WATCH_ALARM = "auto-watch-tick";
const AUTO_WATCH_PERIOD_MIN = 1;
const INVENTORY_URL = "https://www.twitch.tv/drops/inventory";
const DEFAULT_AUTO_OFF_HOURS = 3;
const DEFAULT_TAB_QUOTA = 3;
const EMPTY_COOLDOWN_MS = 5 * 60 * 1000; // how long a "nobody live" game sits out before retrying

const log = (...args) => console.log("[DropClaimer]", ...args);

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
  const cfg = await browser.storage.local.get(["enabled", "watchPhase"]);
  const enabled = cfg.enabled ?? true;

  if (!enabled) {
    browser.browserAction.setBadgeText({ text: "OFF" });
    browser.browserAction.setBadgeBackgroundColor({ color: "#6d6d75" });
    browser.browserAction.setTitle({ title: "Twitch Drop Auto-Claimer (off)" });
    return;
  }

  if (cfg.watchPhase === "all-done") {
    browser.browserAction.setBadgeText({ text: "✓" });
    browser.browserAction.setBadgeBackgroundColor({ color: "#00f593" });
    browser.browserAction.setTitle({ title: "Twitch Drop Auto-Claimer (all drops collected)" });
    return;
  }

  browser.browserAction.setBadgeText({ text: "" });
  browser.browserAction.setBadgeBackgroundColor({ color: "#00f593" });
  browser.browserAction.setTitle({ title: "Twitch Drop Auto-Claimer (running)" });
}

// ============================================================================
// inventory tab upkeep
// ============================================================================
async function openInventoryIfMissing() {
  const tabs = await browser.tabs.query({ url: "*://www.twitch.tv/drops/inventory*" });
  if (tabs.length === 0) {
    await browser.tabs.create({ url: INVENTORY_URL, active: false, pinned: true });
    log("opened inventory tab");
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
// auto-off (unchanged from before)
// ============================================================================
async function checkAutoOff() {
  const cfg = await browser.storage.local.get([
    "enabled", "autoOffEnabled", "autoOffHours", "lastClaimAt", "enabledSince",
  ]);
  if (!cfg.enabled || !cfg.autoOffEnabled) return;

  const hours = cfg.autoOffHours || DEFAULT_AUTO_OFF_HOURS;
  const reference = cfg.lastClaimAt || cfg.enabledSince || Date.now();
  const idleMs = Date.now() - reference;

  if (idleMs >= hours * 60 * 60 * 1000) {
    log(`auto-off: idle ${Math.round(idleMs / 60000)} min >= ${hours}h -> turning off`);
    await browser.storage.local.set({ enabled: false });
  }
}

// ============================================================================
// auto-watch orchestration - one tab per eligible game, up to tabQuota
// ============================================================================
function isGameDone(slug, campaignProgress, invalidSlugs) {
  if (invalidSlugs && invalidSlugs.includes(slug)) return true;
  const p = campaignProgress && campaignProgress[slug];
  if (!p) return false;
  return !!(p.allComplete || p.expired);
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
// ones - never guessed.
function orderByPriority(games, mode, campaignProgress, emptyUntil) {
  const now = Date.now();
  const tagged = games.map((g, i) => ({
    g, i, cooling: (emptyUntil[g.slug] || 0) > now,
  }));

  if (mode === "expiry") {
    const withExpiry = tagged.map((x) => {
      const p = campaignProgress[x.g.slug];
      const expiresAt = p && typeof p.expiresAt === "number" ? p.expiresAt : null;
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
    await browser.storage.local.set({ watchTabs: {}, watchPhase: "idle" });
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
  await browser.storage.local.set({ watchTabs: {}, watchPhase: "all-done" });
  await refreshBadge();
}

// the core scheduler - not self-serializing, callers must go through
// serialized(autoWatchTick)
async function autoWatchTick() {
  const cfg = await browser.storage.local.get([
    "enabled", "autoWatchEnabled", "watchList", "invalidSlugs", "campaignProgress",
    "watchTabs", "tabQuota", "priorityMode", "emptyUntil",
  ]);
  if (!cfg.enabled || !cfg.autoWatchEnabled) return;

  const list = cfg.watchList || [];
  if (list.length === 0) {
    await teardownAllWatch("no games in list");
    return;
  }

  const invalidSlugs = cfg.invalidSlugs || [];
  const campaignProgress = cfg.campaignProgress || {};
  const emptyUntil = cfg.emptyUntil || {};
  const quota = Math.max(1, cfg.tabQuota || DEFAULT_TAB_QUOTA);
  const priorityMode = cfg.priorityMode === "expiry" ? "expiry" : "list-order";
  let watchTabs = { ...(cfg.watchTabs || {}) };

  const eligible = list.filter((g) => !isGameDone(g.slug, campaignProgress, invalidSlugs));

  if (eligible.length === 0) {
    await finishAllDone();
    return;
  }

  // drop tabs for games that are no longer eligible (done, invalid, or
  // removed from the list) - every other game's tab is untouched
  const eligibleSlugs = new Set(eligible.map((g) => g.slug));
  for (const slug of Object.keys(watchTabs)) {
    if (!eligibleSlugs.has(slug)) {
      await closeWatchTab(watchTabs, slug);
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

    const tab = await browser.tabs.create({ url: directoryUrl(game.slug), active: false, pinned: true });
    await browser.tabs.update(tab.id, { active: false, muted: true });
    watchTabs[game.slug] = tab.id;
    openCount++;
    log("opened watch tab for", game.slug, `(${openCount}/${quota})`);
  }

  await browser.storage.local.set({ watchTabs, watchPhase: "watching" });
  await refreshBadge();
}

async function handleDirectoryInvalid(slug) {
  return serialized(async () => {
    const cfg = await browser.storage.local.get(["invalidSlugs", "watchTabs"]);
    const invalidSlugs = cfg.invalidSlugs || [];
    if (!invalidSlugs.includes(slug)) invalidSlugs.push(slug);
    const watchTabs = { ...(cfg.watchTabs || {}) };
    await closeWatchTab(watchTabs, slug);
    await browser.storage.local.set({ invalidSlugs, watchTabs });
    log("slug looks invalid (directory 404/redirect), closed its tab:", slug);
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

async function mergeInventoryProgress(campaigns) {
  if (!campaigns || campaigns.length === 0) return;

  return serialized(async () => {
    const cfg = await browser.storage.local.get(["campaignProgress", "watchTabs"]);
    const progress = cfg.campaignProgress || {};
    const watchTabs = { ...(cfg.watchTabs || {}) };
    let anyJustFinished = false;

    for (const c of campaigns) {
      const allComplete = c.total > 0 && c.claimed >= c.total && !c.accountNotConnected;
      progress[c.slug] = {
        label: c.label,
        claimed: c.claimed,
        total: c.total,
        accountNotConnected: !!c.accountNotConnected,
        expired: !!c.expired,
        allComplete,
        expiresAt: typeof c.expiresAt === "number" ? c.expiresAt : null,
        timeRemainingMin: c.timeRemainingMin ?? null,
        updatedAt: Date.now(),
      };
      if ((allComplete || c.expired) && watchTabs[c.slug]) {
        await closeWatchTab(watchTabs, c.slug);
        anyJustFinished = true;
        log(c.slug, allComplete ? "fully claimed" : "expired", "- closed its tab");
      }
    }

    await browser.storage.local.set({ campaignProgress: progress, watchTabs });
    if (anyJustFinished) await autoWatchTick();
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
    await openInventoryIfMissing();
    await serialized(autoWatchTick);
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
        await openInventoryIfMissing();
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
  } else if (alarm.name === AUTO_OFF_ALARM) {
    checkAutoOff();
  } else if (alarm.name === AUTO_WATCH_ALARM) {
    serialized(autoWatchTick);
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
          "enabled", "autoWatchEnabled", "watchTabs", "watchList",
        ]);
        if (!cfg.enabled || !cfg.autoWatchEnabled || !sender.tab) {
          return { isWatchTab: false, activeGame: null };
        }
        const watchTabs = cfg.watchTabs || {};
        const slug = Object.keys(watchTabs).find((s) => watchTabs[s] === sender.tab.id);
        if (!slug) return { isWatchTab: false, activeGame: null };
        const game = (cfg.watchList || []).find((g) => g.slug === slug) || { slug, input: slug };
        return { isWatchTab: true, activeGame: game };
      })();

    case "directoryInvalid":
      return handleDirectoryInvalid(msg.slug);

    case "directoryEmpty":
      return handleDirectoryEmpty(msg.slug);

    case "inventoryProgress":
      return mergeInventoryProgress(msg.campaigns);

    case "dropClaimed":
      return handleDropClaimed();

    // "directoryPicked" / "channelOffline" / "channelRedirected" are informational
    // only (the content script has already acted); nothing to do here.
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
      await browser.storage.local.set({ enabledSince: Date.now() });
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

  if (changes.watchList) {
    const newList = changes.watchList.newValue || [];
    const slugs = new Set(newList.map((g) => g.slug));
    const cfg = await browser.storage.local.get("invalidSlugs");
    const invalidSlugs = (cfg.invalidSlugs || []).filter((s) => slugs.has(s));
    await browser.storage.local.set({ invalidSlugs });
    await serialized(autoWatchTick);
  }

  if (changes.tabQuota || changes.priorityMode) {
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
