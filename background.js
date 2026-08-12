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
 *    (browser.storage.local `watchList`), keep exactly one pinned background
 *    tab pointed at a live, low-viewer channel of the current game, skipping
 *    to the next game when the current one is fully claimed/expired/invalid/
 *    empty of live channels, and stopping (closing the tab) once every game
 *    in the list is done.
 *
 * Both are fully gated on the `enabled` flag in browser.storage.local -
 * once switched off, nothing here may open a tab, reload one, or fire a
 * request again. Auto-watch is additionally gated on `autoWatchEnabled`.
 */

const RELOAD_ALARM = "reload-inventory";
const RELOAD_PERIOD_MIN = 15;
const AUTO_OFF_ALARM = "auto-off-check";
const AUTO_OFF_PERIOD_MIN = 10;
const AUTO_WATCH_ALARM = "auto-watch-tick";
const AUTO_WATCH_PERIOD_MIN = 1;
const INVENTORY_URL = "https://www.twitch.tv/drops/inventory";
const DEFAULT_AUTO_OFF_HOURS = 3;

const log = (...args) => console.log("[DropClaimer]", ...args);

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
  // a drop was just claimed somewhere -> refresh the inventory tab soon so
  // campaign progress is current, but don't thrash if several claims land at once
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
// auto-watch orchestration
// ============================================================================

// a game counts as "done" (skip it) if its slug turned out to be invalid, or
// its campaign is fully claimed / expired. accountNotConnected never counts
// as done on its own - that just needs the user to link their account, the
// campaign might still be genuinely in progress.
function isGameDone(slug, campaignProgress, invalidSlugs) {
  if (invalidSlugs && invalidSlugs.includes(slug)) return true;
  const p = campaignProgress && campaignProgress[slug];
  if (!p) return false;
  return !!(p.allComplete || p.expired);
}

async function ensureWatchTab(game) {
  const cfg = await browser.storage.local.get(["watchTabId", "watchTabGameSlug"]);
  let tab = null;
  if (cfg.watchTabId) {
    try { tab = await browser.tabs.get(cfg.watchTabId); } catch { tab = null; }
  }

  const targetUrl = directoryUrl(game.slug);
  const sameGame = cfg.watchTabGameSlug === game.slug;

  if (!tab) {
    const created = await browser.tabs.create({ url: targetUrl, active: false, pinned: true });
    await browser.storage.local.set({
      watchTabId: created.id,
      watchTabGameSlug: game.slug,
      watchPhase: "watching",
    });
    log("opened watch tab for", game.slug);
    return;
  }

  if (!sameGame) {
    // active game changed (skip/advance) - always interrupt and re-target,
    // even if the tab was happily sitting on a channel for the old game
    await browser.tabs.update(cfg.watchTabId, { url: targetUrl });
    await browser.storage.local.set({ watchTabGameSlug: game.slug });
    log("redirected watch tab to", game.slug);
  }
  await browser.storage.local.set({ watchPhase: "watching" });
}

async function teardownWatch(reason) {
  const cfg = await browser.storage.local.get(["watchTabId", "watchPhase"]);
  if (cfg.watchTabId) {
    try { await browser.tabs.remove(cfg.watchTabId); } catch { /* already closed */ }
  }
  if (cfg.watchPhase !== "idle") {
    await browser.storage.local.set({ watchTabId: null, watchTabGameSlug: null, watchPhase: "idle" });
  }
  log("auto-watch idle:", reason);
  await refreshBadge();
}

async function finishAllDone() {
  const cfg = await browser.storage.local.get(["watchPhase", "watchTabId"]);
  if (cfg.watchPhase === "all-done") return; // already handled
  log("every tracked game is fully collected - closing the watch tab");
  if (cfg.watchTabId) {
    try { await browser.tabs.remove(cfg.watchTabId); } catch { /* already closed */ }
  }
  await browser.storage.local.set({ watchTabId: null, watchTabGameSlug: null, watchPhase: "all-done" });
  await refreshBadge();
}

// re-evaluate from the current activeGameIndex: skip any already-done games,
// declare "all done" if every game is done, otherwise make sure the watch
// tab is pointed at the right game
async function autoWatchTick() {
  const cfg = await browser.storage.local.get([
    "enabled", "autoWatchEnabled", "watchList", "activeGameIndex",
    "invalidSlugs", "campaignProgress",
  ]);
  if (!cfg.enabled || !cfg.autoWatchEnabled) return;

  const list = cfg.watchList || [];
  if (list.length === 0) {
    await teardownWatch("no games in list");
    return;
  }

  const invalidSlugs = cfg.invalidSlugs || [];
  const campaignProgress = cfg.campaignProgress || {};

  let cursor = cfg.activeGameIndex ?? 0;
  if (cursor >= list.length || cursor < 0) cursor = 0;

  let checked = 0;
  while (checked < list.length && isGameDone(list[cursor].slug, campaignProgress, invalidSlugs)) {
    cursor = (cursor + 1) % list.length;
    checked++;
  }

  if (checked >= list.length) {
    await finishAllDone();
    return;
  }

  if (cursor !== cfg.activeGameIndex) {
    await browser.storage.local.set({ activeGameIndex: cursor });
  }

  await ensureWatchTab(list[cursor]);
  await refreshBadge();
}

async function advanceAutoWatch() {
  const cfg = await browser.storage.local.get(["watchList", "activeGameIndex"]);
  const list = cfg.watchList || [];
  if (list.length === 0) return;
  const next = ((cfg.activeGameIndex ?? 0) + 1) % list.length;
  await browser.storage.local.set({ activeGameIndex: next });
  await autoWatchTick();
}

async function handleDirectoryInvalid(slug) {
  const cfg = await browser.storage.local.get("invalidSlugs");
  const invalidSlugs = cfg.invalidSlugs || [];
  if (!invalidSlugs.includes(slug)) {
    invalidSlugs.push(slug);
    await browser.storage.local.set({ invalidSlugs });
  }
  log("slug looks invalid (directory 404/redirect):", slug);
  await advanceAutoWatch();
}

async function handleDirectoryEmpty(slug) {
  log("no live channels for", slug, "- moving to the next game");
  await advanceAutoWatch();
}

async function mergeInventoryProgress(campaigns) {
  if (!campaigns || campaigns.length === 0) return;

  const cfg = await browser.storage.local.get(["campaignProgress", "watchList", "activeGameIndex"]);
  const progress = cfg.campaignProgress || {};
  const activeSlug = (cfg.watchList || [])[cfg.activeGameIndex ?? 0]?.slug;
  let activeGameJustFinished = false;

  for (const c of campaigns) {
    const allComplete = c.total > 0 && c.claimed >= c.total && !c.accountNotConnected;
    progress[c.slug] = {
      label: c.label,
      claimed: c.claimed,
      total: c.total,
      accountNotConnected: !!c.accountNotConnected,
      expired: !!c.expired,
      allComplete,
      timeRemainingMin: c.timeRemainingMin ?? null,
      updatedAt: Date.now(),
    };
    if (c.slug === activeSlug && (allComplete || c.expired)) activeGameJustFinished = true;
  }

  await browser.storage.local.set({ campaignProgress: progress });

  if (activeGameJustFinished) {
    log("active game's campaign is complete/expired -> advancing now");
    await advanceAutoWatch();
  }
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
    await autoWatchTick();
  } else {
    await browser.alarms.clear(RELOAD_ALARM);
    await browser.alarms.clear(AUTO_OFF_ALARM);
    await browser.alarms.clear(AUTO_WATCH_ALARM);
    await teardownWatch("master switch off");
  }
  await refreshBadge();
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  // always re-check the live value from storage, in case clear() raced the toggle-off
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
    autoWatchTick();
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
          "enabled", "autoWatchEnabled", "watchTabId", "watchTabGameSlug", "watchList",
        ]);
        const isWatchTab = !!(
          cfg.enabled && cfg.autoWatchEnabled && sender.tab && sender.tab.id === cfg.watchTabId
        );
        const activeGame = isWatchTab
          ? (cfg.watchList || []).find((g) => g.slug === cfg.watchTabGameSlug) || null
          : null;
        return { isWatchTab, activeGame };
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
      await autoWatchTick();
    } else {
      await teardownWatch("auto-watch turned off");
    }
  }

  if (changes.watchList) {
    // drop any invalid-slug memory for games no longer in the list, and give
    // "all done" a chance to re-evaluate in case a new game was added
    const newList = changes.watchList.newValue || [];
    const slugs = new Set(newList.map((g) => g.slug));
    const cfg = await browser.storage.local.get(["invalidSlugs", "watchPhase"]);
    const invalidSlugs = (cfg.invalidSlugs || []).filter((s) => slugs.has(s));
    await browser.storage.local.set({ invalidSlugs });
    await autoWatchTick();
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
