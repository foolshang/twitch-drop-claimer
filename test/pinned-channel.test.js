/**
 * pinned-channel.test.js
 *
 * Covers the "@channel" watch-list syntax (see parseWatchList in shared.js):
 * typing a line starting with "@" pins a specific channel instead of a game -
 * its tab goes straight to that channel (never the directory), is never
 * gated on the /drops/campaigns snapshot, is never rotated away for
 * stalling, and gets bound to whatever real game slug content.js reports
 * it's actually playing (handleChannelPlayingGame in background.js), at
 * which point it behaves exactly like an ordinary typed-game entry.
 *
 * Uses the same stubbed tabs registry as auto-watch-multi-tab.test.js /
 * drop-verification.test.js.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function makeSandbox() {
  const storageData = {
    enabled: true, autoWatchEnabled: true, tabQuota: 3,
    openCampaigns: { fetchedAt: Date.now(), bySlug: {} },
  };
  const changeListeners = [];
  const tabsById = new Map();
  let nextTabId = 1;
  let violations = [];

  function auditTabCall(opts) {
    if (opts.active !== false) violations.push(`active !== false: ${JSON.stringify(opts)}`);
  }

  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    browser: {
      storage: {
        local: {
          get: (keys) => {
            if (keys == null) return Promise.resolve({ ...storageData });
            if (typeof keys === "string") return Promise.resolve({ [keys]: storageData[keys] });
            const out = {};
            for (const k of keys) out[k] = storageData[k];
            return Promise.resolve(out);
          },
          set: (obj) => { Object.assign(storageData, obj); return Promise.resolve(); },
        },
        onChanged: { addListener: (fn) => changeListeners.push(fn) },
      },
      runtime: { onMessage: { addListener: () => {} }, getManifest: () => ({ version: "0.0.0-test" }) },
      tabs: {
        create: (opts) => {
          auditTabCall(opts);
          const id = nextTabId++;
          tabsById.set(id, { url: opts.url, active: false, pinned: !!opts.pinned, muted: !!opts.muted });
          return Promise.resolve({ id });
        },
        update: (id, opts) => {
          auditTabCall(opts);
          const t = tabsById.get(id);
          if (t) Object.assign(t, opts);
          return Promise.resolve();
        },
        remove: (id) => {
          if (!tabsById.has(id)) return Promise.reject(new Error("no such tab"));
          tabsById.delete(id);
          return Promise.resolve();
        },
        get: (id) => tabsById.has(id) ? Promise.resolve({ id, ...tabsById.get(id) }) : Promise.reject(new Error("no such tab")),
        query: () => Promise.resolve([]),
        reload: () => {},
      },
      alarms: { create: () => {}, clear: () => Promise.resolve(true), onAlarm: { addListener: () => {} } },
      browserAction: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
      downloads: {
        download: () => Promise.resolve(1),
        search: () => Promise.resolve([{ state: "complete", filename: "TEST/twitch-drop-claimer-debug.log" }]),
      },
    },
    URL: globalThis.URL,
    Blob: globalThis.Blob,
  };

  const ctx = vm.createContext(sandbox);
  function flush(ms = 20) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return { ctx, storageData, tabsById, flush, get violations() { return violations; } };
}

function loadBackground(ctx) {
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext(read("background.js"), ctx);
}

// -----------------------------------------------------------------------
// shared.js: parseWatchList's "@channel" syntax
// -----------------------------------------------------------------------
function testParseWatchListChannelSyntax() {
  const { ctx } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  const parseWatchList = vm.runInContext("parseWatchList", ctx);

  const mixed = parseWatchList("poe2\n@SomeStreamer\ndiablo 4\n@somestreamer\n@\n  \n@bar ");
  assert.strictEqual(mixed.length, 4, "bare '@' skipped, case-insensitive dup of @SomeStreamer dropped");
  const flags = mixed.map((g) => !!g.pinnedChannel).join(",");
  assert.strictEqual(flags, "false,true,false,true");
  assert.strictEqual(mixed[0].slug, "path-of-exile-2");
  assert.strictEqual(mixed[1].channel, "SomeStreamer", "original casing preserved for the actual channel name");
  assert.strictEqual(mixed[1].slug, "channel:somestreamer", "pseudo slug key is lowercased for stable dedup");
  assert.strictEqual(mixed[1].input, "@SomeStreamer");
  assert.strictEqual(mixed[3].channel, "bar");

  console.log("  OK  parseWatchList: '@channel' lines are pinned, deduped case-insensitively, mixed with games");
}

// -----------------------------------------------------------------------
// autoWatchTick: a pinned entry opens the channel page directly, never the
// directory, and is eligible even though openCampaigns has no entry for it
// -----------------------------------------------------------------------
async function testAutoWatchOpensChannelDirectly() {
  const { ctx, storageData, tabsById, flush } = makeSandbox();
  loadBackground(ctx);
  const channelUrl = vm.runInContext("channelUrl", ctx);

  // populated (non-empty) snapshot with no entry at all for this pinned
  // channel's game - lacksOpenCampaign must not gate it on that
  storageData.openCampaigns = {
    fetchedAt: Date.now(),
    bySlug: { "some-other-game": { slug: "some-other-game", active: true } },
  };
  storageData.watchList = [
    { input: "@teststreamer", slug: "channel:teststreamer", channel: "teststreamer", pinnedChannel: true },
  ];

  await flush(30);

  const tabId = storageData.watchTabs["channel:teststreamer"];
  assert.ok(tabId, "pinned entry must get a watch tab under its pseudo slug key");
  const tab = tabsById.get(tabId);
  assert.strictEqual(tab.url, channelUrl("teststreamer"), "must navigate straight to the channel, never the directory");
  assert.ok(!/directory/.test(tab.url), "must never be a directory URL");
  assert.strictEqual(tab.muted, true);

  const meta = storageData.watchMeta["channel:teststreamer"];
  assert.ok(meta, "watchMeta must be populated immediately - no separate 'channel picked' step for a pinned entry");
  assert.strictEqual(meta.channel, "teststreamer");
  assert.strictEqual(meta.tabId, tabId);

  console.log("  OK  autoWatchTick: a pinned entry opens its exact channel directly and is never gated on the campaigns snapshot");
}

// -----------------------------------------------------------------------
// A pinned entry doesn't crowd out / get crowded out unfairly - it shares
// one combined tabQuota with ordinary game entries (list order).
// -----------------------------------------------------------------------
async function testCombinedQuotaAcrossGamesAndChannels() {
  const { ctx, storageData, flush } = makeSandbox();
  loadBackground(ctx);
  storageData.tabQuota = 2;
  storageData.watchList = [
    { input: "poe2", slug: "path-of-exile-2" },
    { input: "@teststreamer", slug: "channel:teststreamer", channel: "teststreamer", pinnedChannel: true },
    { input: "diablo 4", slug: "diablo-iv" },
  ];
  await flush(30);

  const watched = Object.keys(storageData.watchTabs);
  assert.strictEqual(watched.length, 2, "quota is shared across games and pinned channels, not per-type");
  assert.ok(watched.includes("path-of-exile-2") && watched.includes("channel:teststreamer"));
  assert.ok(!watched.includes("diablo-iv"), "3rd list entry (a game) queues behind the pinned channel, same as any game would");

  console.log("  OK  tabQuota is shared between game and pinned-channel entries (list order, no separate pool)");
}

// -----------------------------------------------------------------------
// handleChannelPlayingGame: records the game a pinned entry's channel plays once
// content.js reports it - the entry keeps its own key and its tab
// -----------------------------------------------------------------------
async function testResolvesPinnedChannelToRealSlug() {
  const { ctx, storageData, tabsById, flush } = makeSandbox();
  loadBackground(ctx);
  storageData.watchList = [
    { input: "@teststreamer", slug: "channel:teststreamer", channel: "teststreamer", pinnedChannel: true },
  ];
  await flush(30);
  const tabId = storageData.watchTabs["channel:teststreamer"];
  const tabsBefore = tabsById.size;
  const startedAt = storageData.watchMeta["channel:teststreamer"].watchStartedAt;

  await vm.runInContext("handleChannelPlayingGame", ctx)(
    { channel: "teststreamer", slug: "path-of-exile-2", gameName: "Path of Exile 2" },
    { id: tabId }
  );
  await flush(20);

  // 0.6.16 rewrote the entry's key to the game slug here (and refused when another entry had it)
  assert.strictEqual(storageData.watchTabs["channel:teststreamer"], tabId, "the entry keeps its own key and its tab");
  assert.ok(!storageData.watchTabs["path-of-exile-2"], "the game slug is not an entry key of the pinned channel");
  assert.strictEqual(tabsById.size, tabsBefore, "resolving must never close/recreate the tab");

  const entry = storageData.watchList.find((g) => g.channel === "teststreamer");
  assert.strictEqual(entry.slug, "channel:teststreamer", "key unchanged");
  assert.strictEqual(entry.pinnedChannel, true);
  assert.strictEqual(entry.gameSlug, "path-of-exile-2", "the game it plays is recorded next to the key");
  assert.strictEqual(entry.pinnedGameName, "Path of Exile 2");

  const meta = storageData.watchMeta["channel:teststreamer"];
  assert.strictEqual(meta.channel, "teststreamer");
  assert.strictEqual(meta.tabId, tabId);
  assert.strictEqual(meta.watchStartedAt, startedAt, "finding out the game does not restart the verify clock");

  // reporting the exact same slug again must be a no-op (no churn)
  await vm.runInContext("handleChannelPlayingGame", ctx)(
    { channel: "teststreamer", slug: "path-of-exile-2", gameName: "Path of Exile 2" },
    { id: tabId }
  );
  await flush(20);
  assert.strictEqual(storageData.watchMeta["channel:teststreamer"].watchStartedAt, startedAt, "re-reporting the same game must not reset the verify clock");

  console.log("  OK  handleChannelPlayingGame: the game is recorded on the pinned entry, key and tab untouched");
}

// -----------------------------------------------------------------------
// A pinned channel that later plays a genuinely different game is re-recorded,
// and does NOT carry the previous game's campaign progress with it
// -----------------------------------------------------------------------
async function testGameSwitchDropsStaleProgress() {
  const { ctx, storageData, tabsById, flush } = makeSandbox();
  loadBackground(ctx);
  storageData.watchList = [
    { input: "@teststreamer", slug: "channel:teststreamer", channel: "teststreamer", pinnedChannel: true },
  ];
  await flush(30);
  const tabId = storageData.watchTabs["channel:teststreamer"];

  await vm.runInContext("handleChannelPlayingGame", ctx)(
    { channel: "teststreamer", slug: "path-of-exile-2", gameName: "Path of Exile 2" }, { id: tabId }
  );
  await flush(10);
  await vm.runInContext("mergeInventoryProgress", ctx)([
    { slug: "path-of-exile-2", label: "PoE2", campaignId: "c1", campaignName: "PoE2 streamer drops", channels: ["teststreamer"], claimed: 1, total: 3, timeRemainingMin: 90 },
  ]);
  await flush(10);
  assert.ok(storageData.campaignProgress["channel:teststreamer"], "sanity: progress recorded for the pinned entry from its own card");

  // the channel switched to a different game entirely
  const before = storageData.watchMeta["channel:teststreamer"].watchStartedAt;
  await new Promise((r) => setTimeout(r, 5));
  await vm.runInContext("handleChannelPlayingGame", ctx)(
    { channel: "teststreamer", slug: "diablo-iv", gameName: "Diablo IV" }, { id: tabId }
  );
  await flush(20);

  assert.ok(!storageData.campaignProgress["channel:teststreamer"], "the old game's progress must not linger (and nothing is invented for the new one)");
  assert.strictEqual(storageData.watchTabs["channel:teststreamer"], tabId, "same tab, same key");
  assert.ok(storageData.watchMeta["channel:teststreamer"].watchStartedAt > before, "the verify clock starts afresh on the new game");
  const entry = storageData.watchList.find((g) => g.channel === "teststreamer");
  assert.strictEqual(entry.gameSlug, "diablo-iv");
  assert.strictEqual(entry.pinnedGameName, "Diablo IV");
  assert.strictEqual(tabsById.size, 2, "still just the one watch tab + the always-open inventory tab throughout");

  console.log("  OK  handleChannelPlayingGame: switching to a different game drops the stale progress, tab and key untouched");
}

// -----------------------------------------------------------------------
// A pinned channel playing the game another entry is about must coexist with
// it: two entries, two tabs, two states (0.6.16 refused to bind here)
// -----------------------------------------------------------------------
async function testResolvesAlongsideAGameEntryWithTheSameSlug() {
  const { ctx, storageData, flush } = makeSandbox();
  loadBackground(ctx);
  storageData.watchList = [
    { input: "poe2", slug: "path-of-exile-2" },
    { input: "@teststreamer", slug: "channel:teststreamer", channel: "teststreamer", pinnedChannel: true },
  ];
  await flush(30);
  const gameTab = storageData.watchTabs["path-of-exile-2"];
  const pinnedTab = storageData.watchTabs["channel:teststreamer"];
  assert.ok(gameTab && pinnedTab && gameTab !== pinnedTab, "sanity: each entry has a tab of its own");
  const gameMeta = { ...storageData.watchMeta["path-of-exile-2"] };

  // the pinned channel turns out to play the very game the other entry is about
  await vm.runInContext("handleChannelPlayingGame", ctx)(
    { channel: "teststreamer", slug: "path-of-exile-2", gameName: "Path of Exile 2" }, { id: pinnedTab }
  );
  await flush(20);

  assert.strictEqual(storageData.watchTabs["path-of-exile-2"], gameTab, "the game entry keeps its tab");
  assert.strictEqual(storageData.watchTabs["channel:teststreamer"], pinnedTab, "and the pinned entry keeps its own");
  assert.deepStrictEqual({ ...storageData.watchMeta["path-of-exile-2"] }, gameMeta, "the game entry's state is not touched");
  assert.strictEqual(storageData.watchMeta["channel:teststreamer"].channel, "teststreamer");
  const pinned = storageData.watchList.find((g) => g.channel === "teststreamer");
  assert.strictEqual(pinned.slug, "channel:teststreamer");
  assert.strictEqual(pinned.gameSlug, "path-of-exile-2", "it just knows its game now");
  assert.strictEqual(storageData.watchList.find((g) => g.input === "poe2").slug, "path-of-exile-2");

  console.log("  OK  handleChannelPlayingGame: a pinned channel playing a listed game coexists with that game's entry (no collision)");
}

// -----------------------------------------------------------------------
// A pinned channel that stalls (no drop progress moving) is never rotated
// away / blocklisted the way an auto-picked channel would be - only noted.
// -----------------------------------------------------------------------
async function testStalledPinnedChannelIsNeverRotated() {
  const { ctx, storageData, tabsById, flush } = makeSandbox();
  loadBackground(ctx);
  storageData.watchList = [
    { input: "@teststreamer", slug: "channel:teststreamer", channel: "teststreamer", pinnedChannel: true },
  ];
  await flush(30);
  const tabId = storageData.watchTabs["channel:teststreamer"];
  const KEY = "channel:teststreamer";
  const card = { slug: "path-of-exile-2", label: "PoE2", campaignId: "c1", campaignName: "PoE2 streamer drops", channels: ["teststreamer"], claimed: 0, total: 3, timeRemainingMin: 120 };

  await vm.runInContext("handleChannelPlayingGame", ctx)(
    { channel: "teststreamer", slug: "path-of-exile-2", gameName: "Path of Exile 2" }, { id: tabId }
  );
  await flush(10);

  const VERIFY_DELAY_MS = vm.runInContext("VERIFY_DELAY_MS", ctx);
  storageData.watchMeta[KEY].watchStartedAt = Date.now() - VERIFY_DELAY_MS - 5_000;

  await vm.runInContext("mergeInventoryProgress", ctx)([card]);
  await vm.runInContext("verifySweep", ctx)(); // captures baseline
  await flush(10);
  storageData.watchMeta[KEY].baselineCapturedAt = Date.now() - VERIFY_DELAY_MS - 5_000;

  // no movement at all since the baseline - would rotate a normal channel
  await vm.runInContext("mergeInventoryProgress", ctx)([card]);
  await vm.runInContext("verifySweep", ctx)();
  await flush(10);

  assert.strictEqual(storageData.watchTabs[KEY], tabId, "pinned channel's tab must survive a stalled verify sweep");
  assert.ok(storageData.watchMeta[KEY], "watchMeta must not be cleared - it's the same channel by design, not a rejection");
  assert.ok(
    !(storageData.blockedChannels && storageData.blockedChannels[KEY] && storageData.blockedChannels[KEY].teststreamer),
    "pinned channel must never be added to blockedChannels"
  );
  assert.ok(tabsById.has(tabId), "tab itself must still be open");

  console.log("  OK  verifySweep: a stalled pinned channel is left watching, never rotated/blocklisted");
}


// -----------------------------------------------------------------------
// An entry with no inventory card yet (a card only appears once minutes start
// accruing) has unknown progress - never done, and its tab stays open. This
// holds for a pinned channel and for a game entry whose general campaign has
// no card, even when the inventory shows restricted cards of other channels.
// -----------------------------------------------------------------------
async function testEntryWithoutACardIsStillWatched() {
  const { ctx, storageData, tabsById, flush } = makeSandbox();
  loadBackground(ctx);
  storageData.tabQuota = 3;
  storageData.watchList = [
    { input: "poe2", slug: "path-of-exile-2" },
    { input: "@teststreamer", slug: "channel:teststreamer", channel: "teststreamer", pinnedChannel: true },
  ];
  await flush(30);
  const keys = Object.keys(storageData.watchTabs).sort();
  assert.deepStrictEqual(keys, ["channel:teststreamer", "path-of-exile-2"], "sanity: each entry has a watch tab");
  const tabIds = { ...storageData.watchTabs };

  // the inventory only has a card of a campaign restricted to somebody else's channel
  await vm.runInContext("mergeInventoryProgress", ctx)([
    { slug: "path-of-exile-2", label: "PoE2", campaignId: "c9", campaignName: "Someone else's drops", channels: ["othercaster"], claimed: 1, total: 1, timeRemainingMin: 0 },
  ]);
  await vm.runInContext("serialized(autoWatchTick)", ctx);
  await flush(20);

  assert.ok(!storageData.campaignProgress || !storageData.campaignProgress["path-of-exile-2"], "the game entry is not lent the restricted card");
  assert.ok(!storageData.campaignProgress || !storageData.campaignProgress["channel:teststreamer"], "the pinned entry has no card -> no reading");
  const isGameDone = vm.runInContext("isGameDone", ctx);
  assert.strictEqual(isGameDone("path-of-exile-2", storageData.campaignProgress || {}, {}), false);
  assert.strictEqual(isGameDone("channel:teststreamer", storageData.campaignProgress || {}, {}), false);
  assert.deepStrictEqual({ ...storageData.watchTabs }, tabIds, "both tabs are still there, untouched");
  for (const id of Object.values(tabIds)) assert.ok(tabsById.has(id), "and open");

  console.log("  OK  an entry without an inventory card yet is unknown, not done, and keeps being watched (pinned and game)");
}
(async () => {
  console.log("Running pinned-channel ('@channel') tests (no real browser, no network)...\n");
  try {
    testParseWatchListChannelSyntax();
    await testAutoWatchOpensChannelDirectly();
    await testCombinedQuotaAcrossGamesAndChannels();
    await testResolvesPinnedChannelToRealSlug();
    await testGameSwitchDropsStaleProgress();
    await testResolvesAlongsideAGameEntryWithTheSameSlug();
    await testStalledPinnedChannelIsNeverRotated();
    await testEntryWithoutACardIsStillWatched();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    process.exit(1);
  }
})();
