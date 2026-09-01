/**
 * drop-verification.test.js
 *
 * Exercises the fake-category detection in background.js: verifyDropStatus()
 * comparing a baseline campaignProgress[slug] reading (claimed reward tiers /
 * timeRemainingMin, both sourced from content.js's DOM scrape of the
 * /drops/inventory page via mergeInventoryProgress) against a later reading,
 * and rejectChannel()'s tab-etiquette (active:false) and channel-blocklist
 * bookkeeping. This replaced an earlier GQL-signal-based design (channel-tab
 * DropsHighlightService_AvailableDrops / account-wide Inventory queries)
 * after real instrumentation showed Twitch never issues drops-related GQL
 * queries in a background/pinned tab at all - see HISTORY.md.
 *
 * Uses the same stubbed tabs registry as auto-watch-multi-tab.test.js;
 * time-dependent behavior is simulated by backdating watchMeta.watchStartedAt
 * directly instead of real sleeping.
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

// shared setup: one game in the watch list, a watch tab already open for it,
// and watchStartedAt backdated well past VERIFY_DELAY_MS so every
// verifyDropStatus() call in the test is already eligible to judge (not just
// capture a baseline).
async function setUpWatchingChannel(channelName) {
  const { ctx, storageData, tabsById, flush, violations } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  storageData.watchList = [{ input: "poe2", slug: "path-of-exile-2" }];

  vm.runInContext(read("background.js"), ctx);
  await flush(30);
  const VERIFY_DELAY_MS = vm.runInContext("VERIFY_DELAY_MS", ctx);
  const tabId = storageData.watchTabs["path-of-exile-2"];
  assert.ok(tabId, "sanity: watch tab opened for the only game");

  await vm.runInContext("handleDirectoryPicked", ctx)("path-of-exile-2", channelName, { id: tabId });
  await flush(10);
  assert.strictEqual(storageData.watchMeta["path-of-exile-2"].channel, channelName);
  storageData.watchMeta["path-of-exile-2"].watchStartedAt = Date.now() - VERIFY_DELAY_MS - 5_000;

  return { ctx, storageData, tabsById, flush, violations, tabId };
}

async function reportProgress(ctx, claimed, timeRemainingMin) {
  await vm.runInContext("mergeInventoryProgress", ctx)([
    { slug: "path-of-exile-2", label: "PoE2", claimed, total: 3, timeRemainingMin },
  ]);
}

// verifyDropStatus gates its judgment on elapsed time *since the baseline
// was captured* (baselineCapturedAt), not since the channel started
// watching - see background.js's comment on why (rolling re-check, not
// one-shot). Simulates that elapsing without real sleeping.
function backdateBaseline(ctx, storageData) {
  const VERIFY_DELAY_MS = vm.runInContext("VERIFY_DELAY_MS", ctx);
  storageData.watchMeta["path-of-exile-2"].baselineCapturedAt = Date.now() - VERIFY_DELAY_MS - 5_000;
}

async function testStuckProgressRotatesChannel() {
  const { ctx, storageData, flush, violations, tabId } = await setUpWatchingChannel("streamerA");

  await reportProgress(ctx, 0, 120);
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2"); // captures baseline: claimed=0, timeRemainingMin=120
  await flush(20);
  assert.strictEqual(storageData.watchMeta["path-of-exile-2"].baselineClaimed, 0);
  assert.strictEqual(storageData.watchMeta["path-of-exile-2"].baselineTimeRemainingMin, 120);

  backdateBaseline(ctx, storageData);
  await reportProgress(ctx, 0, 120); // same numbers - no movement
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2");
  await flush(10);

  assert.ok(
    storageData.blockedChannels["path-of-exile-2"]["streamera"] > Date.now(),
    "streamerA must be recorded in blockedChannels for a cooldown"
  );
  assert.ok(!storageData.watchMeta["path-of-exile-2"], "watchMeta must be cleared after rejecting the channel");
  assert.ok(storageData.watchTabs["path-of-exile-2"] === tabId, "the tab must not be closed, only navigated back to the directory");
  assert.deepStrictEqual(violations, [], "no tab call skipped active:false");

  console.log("  OK  unchanged claimed/timeRemainingMin after the verify delay rotates the channel");
}

async function testDecreasingTimeRemainingKeepsWatching() {
  const { ctx, storageData, flush, violations } = await setUpWatchingChannel("streamerB");

  await reportProgress(ctx, 0, 120);
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2"); // baseline: timeRemainingMin=120
  await flush(20);

  backdateBaseline(ctx, storageData);
  await reportProgress(ctx, 0, 95); // fewer minutes left -> progressing
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2");
  await flush(10);

  assert.ok(storageData.watchMeta["path-of-exile-2"], "watchMeta must survive - channel is crediting progress");
  assert.strictEqual(
    storageData.watchMeta["path-of-exile-2"].baselineTimeRemainingMin, 95,
    "must have re-baselined to the new reading"
  );
  assert.ok(
    !(storageData.blockedChannels && storageData.blockedChannels["path-of-exile-2"]),
    "streamerB must not have been rejected/blocklisted"
  );
  assert.deepStrictEqual(violations, [], "no tab call skipped active:false");

  console.log("  OK  decreasing timeRemainingMin keeps the current channel and re-baselines (no rotation)");
}

async function testIncreasingClaimedKeepsWatching() {
  const { ctx, storageData, flush, violations } = await setUpWatchingChannel("streamerC");

  await reportProgress(ctx, 0, null); // timeRemainingMin never parseable for this card
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2"); // baseline: claimed=0, timeRemainingMin=null
  await flush(20);

  backdateBaseline(ctx, storageData);
  await reportProgress(ctx, 1, null); // a reward tier finished claiming -> progressing
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2");
  await flush(10);

  assert.ok(storageData.watchMeta["path-of-exile-2"], "watchMeta must survive - claimed count moved");
  assert.ok(!(storageData.blockedChannels && storageData.blockedChannels["path-of-exile-2"]));
  assert.deepStrictEqual(violations, [], "no tab call skipped active:false");

  console.log("  OK  rising claimed-tier count (fallback signal) keeps the current channel (no rotation)");
}

async function testNoUsableSignalFailsClosed() {
  const { ctx, storageData, flush, violations } = await setUpWatchingChannel("streamerD");

  await reportProgress(ctx, 0, null); // timeRemainingMin never parseable, claimed never moves either
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2"); // baseline
  await flush(20);

  backdateBaseline(ctx, storageData);
  await reportProgress(ctx, 0, null); // still nothing usable to compare
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2");
  await flush(10);

  assert.ok(
    storageData.watchMeta["path-of-exile-2"],
    "watchMeta must survive - with no usable signal at all this must fail closed, not reject a possibly-fine channel"
  );
  assert.ok(!(storageData.blockedChannels && storageData.blockedChannels["path-of-exile-2"]));
  assert.deepStrictEqual(violations, [], "no tab call skipped active:false");

  console.log("  OK  no usable claimed/timeRemainingMin signal at all fails closed (keeps watching, doesn't reject)");
}

// the bug this locks in: a channel that progressed through one verify
// window (and got re-baselined, kept watching) must NOT become permanently
// exempt from ever being checked again - if it then stops progressing
// (e.g. goes offline), the *next* window must still catch and rotate it.
async function testStopsProgressingAfterOneGoodWindowStillRotates() {
  const { ctx, storageData, flush, violations } = await setUpWatchingChannel("streamerI");

  // window 1: capture baseline
  await reportProgress(ctx, 0, 120);
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2");
  await flush(20);

  // window 1 elapses with real movement -> re-baseline, keep watching
  backdateBaseline(ctx, storageData);
  await reportProgress(ctx, 0, 90);
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2");
  await flush(20);
  assert.ok(storageData.watchMeta["path-of-exile-2"], "must still be watching after one good window");
  assert.strictEqual(
    storageData.watchMeta["path-of-exile-2"].baselineTimeRemainingMin, 90,
    "must have re-baselined to the new reading, not left the original 120 in place"
  );

  // window 2 elapses with NO further movement (e.g. the channel went
  // offline right after the good window) - with the old bug, this would
  // keep comparing against the *original* 120 baseline forever (90 < 120
  // always looks like "progress") and never reject
  backdateBaseline(ctx, storageData);
  await reportProgress(ctx, 0, 90); // unchanged since the re-baseline
  await vm.runInContext("verifyDropStatus", ctx)("path-of-exile-2");
  await flush(10);

  assert.ok(
    !storageData.watchMeta["path-of-exile-2"],
    "watchMeta must be cleared - a second stuck window must reject, not be shielded by the earlier good window"
  );
  assert.ok(storageData.blockedChannels["path-of-exile-2"]["streameri"] > Date.now());
  assert.deepStrictEqual(violations, [], "no tab call skipped active:false");

  console.log("  OK  a channel that stops progressing after one good verify window still gets rotated on the next (rolling check, not one-shot)");
}

// handleChannelLeft (fired by content.js's DOM-based offline/raid check)
// must never be able to reject/blocklist a channel on its own - a false
// DOM read previously caused live, crediting channels to get rotated away
// via a different mechanism (the now-reverted playback-beacon signal, see
// HISTORY.md). Only verifyDropStatus's campaign-progress comparison may
// do that.
async function testChannelLeftDoesNotRejectOnItsOwn() {
  const { ctx, storageData, flush, violations } = await setUpWatchingChannel("streamerE");

  await vm.runInContext("handleChannelLeft", ctx)("path-of-exile-2");
  await flush(10);

  assert.ok(
    storageData.watchMeta["path-of-exile-2"],
    "watchMeta must survive - a DOM-only offline/redirect report must never clear it by itself"
  );
  assert.ok(
    !(storageData.blockedChannels && storageData.blockedChannels["path-of-exile-2"]),
    "the channel must not be blocklisted by the DOM signal alone"
  );
  assert.deepStrictEqual(violations, [], "no tab call skipped active:false");

  console.log("  OK  a DOM-detected offline/redirect report alone does not reject/blocklist the channel");
}

// content.js's directory picker can re-select the same channel it was just
// DOM-bounced away from before Twitch's own listing catches up. If that
// reset the verify clock every time, a genuinely stuck channel that keeps
// getting re-picked this way would never accumulate enough elapsed time
// for verifyDropStatus to ever judge it.
async function testSameChannelRepickPreservesVerifyClock() {
  const { ctx, storageData, flush, violations, tabId } = await setUpWatchingChannel("streamerF");
  const preservedStartedAt = storageData.watchMeta["path-of-exile-2"].watchStartedAt;
  storageData.watchMeta["path-of-exile-2"].baselineCapturedAt = Date.now() - 60_000;
  storageData.watchMeta["path-of-exile-2"].baselineClaimed = 0;
  storageData.watchMeta["path-of-exile-2"].baselineTimeRemainingMin = 100;

  await vm.runInContext("handleDirectoryPicked", ctx)("path-of-exile-2", "streamerF", { id: tabId });
  await flush(10);

  const meta = storageData.watchMeta["path-of-exile-2"];
  assert.strictEqual(meta.watchStartedAt, preservedStartedAt, "re-picking the same channel must not reset the verify clock");
  assert.strictEqual(meta.baselineClaimed, 0, "an existing baseline must survive a same-channel re-pick too");
  assert.deepStrictEqual(violations, [], "no tab call skipped active:false");

  console.log("  OK  re-picking the same channel preserves the existing verify clock/baseline (no reset)");
}

// sanity check for the opposite case, so the same-channel special-casing
// above can't accidentally swallow genuinely new picks too
async function testDifferentChannelResetsVerifyClock() {
  const { ctx, storageData, flush, tabId } = await setUpWatchingChannel("streamerG");
  storageData.watchMeta["path-of-exile-2"].baselineCapturedAt = Date.now() - 60_000;
  storageData.watchMeta["path-of-exile-2"].baselineClaimed = 2;

  await vm.runInContext("handleDirectoryPicked", ctx)("path-of-exile-2", "streamerH", { id: tabId });
  await flush(10);

  const meta = storageData.watchMeta["path-of-exile-2"];
  assert.strictEqual(meta.channel, "streamerH");
  assert.strictEqual(meta.baselineCapturedAt, undefined, "a genuinely different channel must get a fresh baseline");
  assert.ok(Date.now() - meta.watchStartedAt < 1000, "a genuinely different channel must get a fresh watchStartedAt");

  console.log("  OK  picking a genuinely different channel still resets the verify clock/baseline as before");
}

(async () => {
  console.log("Running drop-status verification tests (no real browser, no network)...\n");
  try {
    await testStuckProgressRotatesChannel();
    await testDecreasingTimeRemainingKeepsWatching();
    await testIncreasingClaimedKeepsWatching();
    await testNoUsableSignalFailsClosed();
    await testStopsProgressingAfterOneGoodWindowStillRotates();
    await testChannelLeftDoesNotRejectOnItsOwn();
    await testSameChannelRepickPreservesVerifyClock();
    await testDifferentChannelResetsVerifyClock();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    process.exit(1);
  }
})();
