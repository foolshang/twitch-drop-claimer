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
// handleChannelPlayingGame: binds a pinned entry to the real game slug once
// content.js reports it, migrating storage keys without touching the tab
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

  await vm.runInContext("handleChannelPlayingGame", ctx)(
    { channel: "teststreamer", slug: "path-of-exile-2", gameName: "Path of Exile 2" },
    { id: tabId }
  );
  await flush(20);

  assert.ok(!storageData.watchTabs["channel:teststreamer"], "pseudo key must be gone after resolution");
  assert.strictEqual(storageData.watchTabs["path-of-exile-2"], tabId, "same tab, just re-keyed to the real slug");
  assert.strictEqual(tabsById.size, tabsBefore, "resolving must never close/recreate the tab");

  const entry = storageData.watchList.find((g) => g.channel === "teststreamer");
  assert.strictEqual(entry.slug, "path-of-exile-2");
  assert.strictEqual(entry.pinnedChannel, true, "still marked pinned - must keep behaving like a pinned entry");
  assert.strictEqual(entry.pinnedGameName, "Path of Exile 2");

  const meta = storageData.watchMeta["path-of-exile-2"];
  assert.ok(meta, "watchMeta must exist under the new real-slug key");
  assert.strictEqual(meta.channel, "teststreamer");
  assert.strictEqual(meta.tabId, tabId);
  assert.ok(!storageData.watchMeta["channel:teststreamer"], "old pseudo-key watchMeta must be gone");

  // reporting the exact same slug again must be a no-op (no churn)
  const startedAt = meta.watchStartedAt;
  await vm.runInContext("handleChannelPlayingGame", ctx)(
    { channel: "teststreamer", slug: "path-of-exile-2", gameName: "Path of Exile 2" },
    { id: tabId }
  );
  await flush(20);
  assert.strictEqual(storageData.watchMeta["path-of-exile-2"].watchStartedAt, startedAt, "re-reporting the same game must not reset the verify clock");

  console.log("  OK  handleChannelPlayingGame: pinned entry is rebound to the real game slug in place, tab untouched");
}

// -----------------------------------------------------------------------
// A pinned channel that later plays a genuinely different game gets rebound
// again, and does NOT carry the previous game's campaign progress with it
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
    { slug: "path-of-exile-2", label: "PoE2", claimed: 1, total: 3, timeRemainingMin: 90 },
  ]);
  await flush(10);
  assert.ok(storageData.campaignProgress["path-of-exile-2"], "sanity: progress recorded for the first game");

  // the channel switched to a different game entirely
  await vm.runInContext("handleChannelPlayingGame", ctx)(
    { channel: "teststreamer", slug: "diablo-iv", gameName: "Diablo IV" }, { id: tabId }
  );
  await flush(20);

  assert.ok(!storageData.campaignProgress["path-of-exile-2"], "old game's progress must not linger under the old slug");
  assert.ok(!storageData.campaignProgress["diablo-iv"], "new game's progress must start fresh (not invented)");
  assert.strictEqual(storageData.watchTabs["diablo-iv"], tabId, "same tab, migrated to the new slug");
  assert.ok(!storageData.watchTabs["path-of-exile-2"], "old slug entry must be gone");
  assert.strictEqual(storageData.watchList.find((g) => g.channel === "teststreamer").pinnedGameName, "Diablo IV");
  assert.strictEqual(tabsById.size, 2, "still just the one watch tab + the always-open inventory tab throughout");

  console.log("  OK  handleChannelPlayingGame: switching to a different game rebinds cleanly, drops stale progress");
}

// -----------------------------------------------------------------------
// Binding must refuse to collide with a slug already tracked by another
// (ordinary) watch-list entry, rather than corrupting both entries' state
// -----------------------------------------------------------------------
async function testResolutionSkipsOnCollision() {
  const { ctx, storageData, flush } = makeSandbox();
  loadBackground(ctx);
  storageData.watchList = [
    { input: "poe2", slug: "path-of-exile-2" },
    { input: "@teststreamer", slug: "channel:teststreamer", channel: "teststreamer", pinnedChannel: true },
  ];
  await flush(30);
  const tabId = storageData.watchTabs["channel:teststreamer"];

  await vm.runInContext("handleChannelPlayingGame", ctx)(
    { channel: "teststreamer", slug: "path-of-exile-2", gameName: "Path of Exile 2" }, { id: tabId }
  );
  await flush(20);

  assert.strictEqual(storageData.watchTabs["channel:teststreamer"], tabId, "pinned entry stays parked under its pseudo slug on collision");
  assert.ok(!storageData.watchMeta["path-of-exile-2"] || storageData.watchMeta["path-of-exile-2"].channel !== "teststreamer",
    "must not steal the other entry's slot");
  const entry = storageData.watchList.find((g) => g.channel === "teststreamer");
  assert.strictEqual(entry.slug, "channel:teststreamer", "unresolved - left parked rather than corrupting the existing game entry");

  console.log("  OK  handleChannelPlayingGame: refuses to bind onto a slug another watch-list entry already owns");
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

  await vm.runInContext("handleChannelPlayingGame", ctx)(
    { channel: "teststreamer", slug: "path-of-exile-2", gameName: "Path of Exile 2" }, { id: tabId }
  );
  await flush(10);

  const VERIFY_DELAY_MS = vm.runInContext("VERIFY_DELAY_MS", ctx);
  storageData.watchMeta["path-of-exile-2"].watchStartedAt = Date.now() - VERIFY_DELAY_MS - 5_000;

  await vm.runInContext("mergeInventoryProgress", ctx)([
    { slug: "path-of-exile-2", label: "PoE2", claimed: 0, total: 3, timeRemainingMin: 120 },
  ]);
  await vm.runInContext("verifySweep", ctx)(); // captures baseline
  await flush(10);
  storageData.watchMeta["path-of-exile-2"].baselineCapturedAt = Date.now() - VERIFY_DELAY_MS - 5_000;

  // no movement at all since the baseline - would rotate a normal channel
  await vm.runInContext("mergeInventoryProgress", ctx)([
    { slug: "path-of-exile-2", label: "PoE2", claimed: 0, total: 3, timeRemainingMin: 120 },
  ]);
  await vm.runInContext("verifySweep", ctx)();
  await flush(10);

  assert.strictEqual(storageData.watchTabs["path-of-exile-2"], tabId, "pinned channel's tab must survive a stalled verify sweep");
  assert.ok(storageData.watchMeta["path-of-exile-2"], "watchMeta must not be cleared - it's the same channel by design, not a rejection");
  assert.ok(
    !(storageData.blockedChannels && storageData.blockedChannels["path-of-exile-2"] && storageData.blockedChannels["path-of-exile-2"].teststreamer),
    "pinned channel must never be added to blockedChannels"
  );
  assert.ok(tabsById.has(tabId), "tab itself must still be open");

  console.log("  OK  verifySweep: a stalled pinned channel is left watching, never rotated/blocklisted");
}

(async () => {
  console.log("Running pinned-channel ('@channel') tests (no real browser, no network)...\n");
  try {
    testParseWatchListChannelSyntax();
    await testAutoWatchOpensChannelDirectly();
    await testCombinedQuotaAcrossGamesAndChannels();
    await testResolvesPinnedChannelToRealSlug();
    await testGameSwitchDropsStaleProgress();
    await testResolutionSkipsOnCollision();
    await testStalledPinnedChannelIsNeverRotated();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    process.exit(1);
  }
})();
