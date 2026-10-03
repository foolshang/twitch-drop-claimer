/**
 * review-b-background.test.js - findings B1, B8, B9, B10 of the 0.6.24 code review (background.js)
 *
 *  B1  switching off while a tick is running: the teardown ran beside the tick and the tick wrote its new tab back
 *  B8  a tab that disappears took nothing with it: its watchMeta/dropSignals (verify baseline) stayed
 *  B9  the live session was marked "flashed" before the flash - a skipped flash gave up the whole session
 *  B10 read-modify-write of claimHealth / claimNotLinked without a queue: concurrent messages lost updates
 */

const vm = require("vm");
const assert = require("assert");
const { makeClock, makeBackground } = require("./claim-harness");
const { makeWorld } = require("./world-helpers");

async function testSwitchingOffWhileATickRunsLeavesNoTab() {
  const w = makeWorld({ enabled: true, watchList: [] }, { createDelay: 80 });
  await w.boot();
  w.storageData.watchList = [{ input: "x", slug: "x" }];
  w.storageData.openCampaigns = { fetchedAt: Date.now(), bySlug: { x: { slug: "x", displayName: "x", active: true } } };
  const tick = w.tick(); // opens x's tab (slowly)
  await w.wait(15);
  w.storageData.enabled = false; // the user switches the extension off while the tick is mid-way
  await vm.runInContext("applyEnabledState(false)", w.ctx);
  await tick;
  await w.wait(100);
  const dirTabs = [...w.tabsById.values()].filter((t) => /\/directory\//.test(t.url));
  assert.deepStrictEqual(dirTabs, [], "no watch tab survives the switch-off: " + JSON.stringify(dirTabs));
  assert.deepStrictEqual(Object.keys(w.storageData.watchTabs || {}), [], "and none is remembered");
  // nothing is opened while it stays off
  w.storageData.watchList = [{ input: "x", slug: "x" }, { input: "y", slug: "y" }];
  await vm.runInContext("serialized(autoWatchTick)", w.ctx);
  assert.deepStrictEqual([...w.tabsById.values()].filter((t) => /\/directory\//.test(t.url)), []);
  console.log("  OK  B1: a switch-off waits for the running tick and closes what it opened; nothing opens while off");
}

async function testAGoneTabTakesItsVerifyBaselineWithIt() {
  const w = makeWorld({
    enabled: true, tabQuota: 1,
    watchList: [{ input: "x", slug: "x" }],
    openCampaigns: { fetchedAt: Date.now(), bySlug: { x: { slug: "x", displayName: "x", active: true } } },
    watchTabs: { x: 999 }, // a tab that no longer exists
    watchMeta: { x: { channel: "oldchannel", tabId: 999, watchStartedAt: 1, baselineCapturedAt: 1, baselineClaimed: 0, baselineTimeRemainingMin: 100 } },
    dropSignals: { x: { seenAt: 1 } },
  });
  await w.boot();
  await w.settledTick();
  assert.ok(w.storageData.watchTabs.x && w.storageData.watchTabs.x !== 999, "the game got a new tab");
  assert.strictEqual(w.storageData.watchMeta.x, undefined, "the old tab's baseline is gone: " + JSON.stringify(w.storageData.watchMeta));
  assert.strictEqual(w.storageData.dropSignals.x, undefined);

  // closing a tab (any way) clears its entries at once
  const id = w.storageData.watchTabs.x;
  w.storageData.watchMeta = { x: { channel: "c", tabId: id, watchStartedAt: 1 } };
  w.storageData.idlePinned = { x: true };
  for (const fn of w.removedListeners) fn(id);
  await w.wait(60);
  assert.deepStrictEqual([w.storageData.watchTabs.x, w.storageData.watchMeta.x, w.storageData.idlePinned.x], [undefined, undefined, undefined], "tabs.onRemoved cleans every per-tab entry");
  console.log("  OK  B8: a tab that is gone takes its baseline/signals/idle mark with it (also via tabs.onRemoved)");
}

async function testASkippedFlashDoesNotGiveUpTheLiveSession() {
  const slug = "channel:blooprint";
  const w = makeWorld({
    enabled: true, tabQuota: 3,
    watchList: [{ input: "@blooprint", slug, channel: "blooprint", pinnedChannel: true }],
    watchTabs: { [slug]: 5 }, watchMeta: { [slug]: { channel: "blooprint", tabId: 5, watchStartedAt: 1 } },
  });
  w.tabsById.set(5, { url: "https://www.twitch.tv/blooprint" }); // the tab exists before the scheduler looks
  await w.boot();
  const flashes = [];
  Object.assign(w.ctx, { __flashes: flashes });
  vm.runInContext(`
    getOrCreateWatchWindow = async () => ({ id: 100, freshlyCreated: false });
    flashTabToStartPlayback = async (id) => { __flashes.push(id); lastPlaybackFlashAt.set(id, Date.now()); };
    browser.tabs.get = async (id) => ({ id, windowId: 100 });
    lastPlaybackFlashAt.set(5, Date.now()); // a flash happened moments ago (from another cause)
  `, w.ctx);

  await w.send({ type: "pinnedChannelStatus", channel: "blooprint", live: true }, 5);
  assert.strictEqual(flashes.length, 0, "within the gap: skipped");
  w.advance(3 * 60_000); // past the 2-minute gap, the channel is still live
  await w.send({ type: "pinnedChannelStatus", channel: "blooprint", live: true }, 5);
  assert.deepStrictEqual(flashes, [5], "the next live report flashes it: the skipped one did not use up the live session");
  await w.send({ type: "pinnedChannelStatus", channel: "blooprint", live: true }, 5);
  w.advance(3 * 60_000);
  await w.send({ type: "pinnedChannelStatus", channel: "blooprint", live: true }, 5);
  assert.strictEqual(flashes.length, 1, "and once flashed, it stays once per live session");
  console.log("  OK  B9: a skipped flash is retried with the next live report; a done one is not repeated");
}

async function testConcurrentClaimMessagesLoseNoUpdate() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  await Promise.all(["rewardA", "rewardB", "rewardC"].map((k) => bg.send({ type: "claimResult", key: `c:${k}`, ok: false }, 1)));
  assert.strictEqual(bg.local.claimHealth.streak, 3, "three rejected claims in the same instant: streak 3 (was 1): " + JSON.stringify(bg.local.claimHealth));

  await Promise.all(["g1", "g2", "g3"].map((k) => bg.send({ type: "claimNotLinked", key: `c:${k}`, game: k, reward: k }, 1)));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bg.local.claimNotLinked.map((e) => e.key).sort())), ["c:g1", "c:g2", "c:g3"], "all three warnings are kept");
  await Promise.all(["h1", "h2"].map((k) => bg.send({ type: "claimLinkReminder", key: `c:${k}`, game: k, reward: k }, 1)));
  assert.strictEqual(bg.local.claimLinkReminders.length, 2, "and both reminders");
  console.log("  OK  B10: concurrent claim messages are applied one after another - no lost update");
}

(async () => {
  console.log("Running review group B (background) tests...\n");
  try {
    await testSwitchingOffWhileATickRunsLeavesNoTab();
    await testAGoneTabTakesItsVerifyBaselineWithIt();
    await testASkippedFlashDoesNotGiveUpTheLiveSession();
    await testConcurrentClaimMessagesLoseNoUpdate();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
