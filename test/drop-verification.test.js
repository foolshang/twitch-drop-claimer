/**
 * drop-verification.test.js
 *
 * Exercises the fake-category detection added to background.js:
 * verifyDropStatus()'s two signal paths (GQL channelCampaigns / Inventory
 * minutes-watched) and rejectChannel()'s tab-etiquette (active:false) and
 * channel-blocklist bookkeeping. Uses the same stubbed tabs registry as
 * auto-watch-multi-tab.test.js; time-dependent behavior is simulated by
 * backdating watchMeta.watchStartedAt directly instead of real sleeping.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function makeSandbox() {
  const storageData = { enabled: true, autoWatchEnabled: true, tabQuota: 1 };
  const changeListeners = [];
  const alarmListeners = [];
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
      runtime: { onMessage: { addListener: () => {} } },
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
      alarms: {
        create: () => {},
        clear: () => Promise.resolve(true),
        onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
      },
      browserAction: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
    },
  };

  const ctx = vm.createContext(sandbox);
  function flush(ms = 15) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return { ctx, storageData, tabsById, flush, get violations() { return violations; } };
}

async function testGqlNegativeSignalRotatesChannel() {
  const { ctx, storageData, tabsById, flush, violations } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  storageData.watchList = [{ input: "poe2", slug: "path-of-exile-2" }];

  vm.runInContext(read("background.js"), ctx);
  await flush(30);

  const tabId = storageData.watchTabs["path-of-exile-2"];
  assert.ok(tabId, "sanity: watch tab opened for the only game");

  await vm.runInContext("handleDirectoryPicked", ctx)("path-of-exile-2", "streamerA", { id: tabId });
  await flush(10);
  assert.strictEqual(storageData.watchMeta["path-of-exile-2"].channel, "streamerA");

  // backdate watchStartedAt so the signal below is past GQL_SETTLE_MS
  storageData.watchMeta["path-of-exile-2"].watchStartedAt = Date.now() - 30_000;

  await vm.runInContext("handleGqlDropSignal", ctx)(
    { signal: { kind: "channelCampaigns", campaignIds: [] }, at: Date.now() },
    { id: tabId }
  );
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2");
  await flush(10);

  const tab = tabsById.get(tabId);
  assert.ok(tab, "the tab must not be closed, only navigated back to the directory");
  assert.strictEqual(tab.url, "https://www.twitch.tv/directory/category/path-of-exile-2?filter=drops");
  assert.strictEqual(tab.active, false, "the rotate navigation must stay active:false");
  assert.ok(
    storageData.blockedChannels["path-of-exile-2"]["streamera"] > Date.now(),
    "streamerA must be recorded in blockedChannels for a cooldown"
  );
  assert.ok(!storageData.watchMeta["path-of-exile-2"], "watchMeta must be cleared after rejecting the channel");
  assert.deepStrictEqual(violations, [], "no tab call skipped active:false");

  console.log("  OK  GQL channelCampaigns=[] rotates the tab back to the directory and blocklists the channel");
}

async function testActiveMinutesKeepsWatching() {
  const { ctx, storageData, tabsById, flush, violations } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  storageData.watchList = [{ input: "poe2", slug: "path-of-exile-2" }];

  vm.runInContext(read("background.js"), ctx);
  await flush(30);
  const tabId = storageData.watchTabs["path-of-exile-2"];

  await vm.runInContext("handleDirectoryPicked", ctx)("path-of-exile-2", "streamerB", { id: tabId });
  await flush(10);
  storageData.watchMeta["path-of-exile-2"].watchStartedAt = Date.now() - 150_000; // past VERIFY_DELAY_MS

  // first Inventory reading only establishes the baseline
  await vm.runInContext("handleGqlDropSignal", ctx)(
    { signal: { kind: "inventory", campaigns: [{ gameName: "Path of Exile 2", minutesWatched: 4 }] }, at: Date.now() },
    { id: tabId }
  );
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2");
  await flush(10);
  assert.strictEqual(storageData.watchMeta["path-of-exile-2"].minutesWatchedAtStart, 4);

  // a later reading shows minutes climbing -> must NOT rotate
  await vm.runInContext("handleGqlDropSignal", ctx)(
    { signal: { kind: "inventory", campaigns: [{ gameName: "Path of Exile 2", minutesWatched: 9 }] }, at: Date.now() },
    { id: tabId }
  );
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2");
  await flush(10);

  assert.ok(storageData.watchMeta["path-of-exile-2"], "watchMeta must survive - channel is crediting progress");
  assert.ok(
    !(storageData.blockedChannels && storageData.blockedChannels["path-of-exile-2"]),
    "streamerB must not have been rejected/blocklisted"
  );
  assert.deepStrictEqual(violations, [], "no tab call skipped active:false");

  console.log("  OK  rising minutes-watched keeps the current channel (no rotation)");
}

async function testStuckMinutesRotatesChannel() {
  const { ctx, storageData, tabsById, flush, violations } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  storageData.watchList = [{ input: "poe2", slug: "path-of-exile-2" }];

  vm.runInContext(read("background.js"), ctx);
  await flush(30);
  const tabId = storageData.watchTabs["path-of-exile-2"];

  await vm.runInContext("handleDirectoryPicked", ctx)("path-of-exile-2", "streamerC", { id: tabId });
  await flush(10);
  storageData.watchMeta["path-of-exile-2"].watchStartedAt = Date.now() - 150_000;

  await vm.runInContext("handleGqlDropSignal", ctx)(
    { signal: { kind: "inventory", campaigns: [{ gameName: "Path of Exile 2", minutesWatched: 6 }] }, at: Date.now() },
    { id: tabId }
  );
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2"); // establishes baseline = 6
  await flush(10);

  // same 6 minutes as the baseline - no movement
  await vm.runInContext("handleGqlDropSignal", ctx)(
    { signal: { kind: "inventory", campaigns: [{ gameName: "Path of Exile 2", minutesWatched: 6 }] }, at: Date.now() },
    { id: tabId }
  );
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2");
  await flush(10);

  const tab = tabsById.get(tabId);
  assert.strictEqual(tab.url, "https://www.twitch.tv/directory/category/path-of-exile-2?filter=drops");
  assert.strictEqual(tab.active, false);
  assert.ok(!storageData.watchMeta["path-of-exile-2"]);
  assert.deepStrictEqual(violations, [], "no tab call skipped active:false");

  console.log("  OK  stuck minutes-watched after the verify delay rotates the channel");
}

(async () => {
  console.log("Running drop-status verification tests (no real browser, no network)...\n");
  try {
    await testGqlNegativeSignalRotatesChannel();
    await testActiveMinutesKeepsWatching();
    await testStuckMinutesRotatesChannel();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    process.exit(1);
  }
})();
