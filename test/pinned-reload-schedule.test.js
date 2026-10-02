/**
 * pinned-reload-schedule.test.js
 *
 * Real use (issue #9, v0.6.19): four pinned channels that were offline were each reloaded
 * every 3 minutes - ~80 automated reloads an hour. Now an offline pinned channel is reloaded
 * on a growing interval (3 -> 6 -> 10 -> 15 min, then every 15), back to the short one when
 * the channel is seen live. The sidebar-live hint still reloads at once, so going live is
 * caught quickly. The reload line is logged on change + one summary per 15 minutes.
 *
 * Real background.js, fake clock, a status report per minute like content.js sends.
 */

const vm = require("vm");
const assert = require("assert");
const { MIN, flush, makeClock, makeBackground } = require("./claim-harness");

const TAB = 5;
const CHANNEL = "xChocoBars";

async function world() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const reloads = [];
  vm.runInContext("browser.tabs.reload = (id) => { __reloads.push([id, Date.now()]); return Promise.resolve(); }", Object.assign(bg.ctx, { __reloads: reloads }) && bg.ctx);
  bg.ctx.__reloads = reloads;
  bg.local.enabled = true;
  bg.local.watchTabs = { "channel:xchocobars": TAB };
  bg.local.watchList = [{ input: "@xChocoBars", slug: "channel:xchocobars", channel: CHANNEL, pinnedChannel: true }];
  const status = async (live, extra = {}) => { await bg.send({ type: "pinnedChannelStatus", channel: CHANNEL, live, ...extra }, TAB); await flush(); };
  // one status report per minute, as content.js sends them
  const minutes = async (n, live = false, extra = {}) => {
    for (let i = 0; i < n; i++) { clock.advanceTo(clock.now + MIN); await status(live, extra); }
  };
  return { clock, bg, reloads, status, minutes };
}

const gapsMin = (reloads) => reloads.slice(1).map((r, i) => Math.round((r[1] - reloads[i][1]) / MIN));

async function testOfflineReloadIntervalGrows() {
  const { bg, reloads, minutes } = await world();
  await minutes(3 + 6 + 10 + 15 + 15 + 15);
  assert.strictEqual(reloads.length, 6, "six reloads in 64 minutes (it was 21): " + reloads.length);
  assert.deepStrictEqual(gapsMin(reloads), [6, 10, 15, 15, 15], "the gaps grow 3 -> 6 -> 10 -> 15 and stay at 15");
  // 8 hours offline: ~34 reloads instead of 160
  await minutes(8 * 60 - 64);
  assert.ok(reloads.length <= 36, "8 hours = " + reloads.length + " reloads");
  const lines = bg.logLines().filter((l) => /still offline/.test(l));
  assert.ok(lines.length <= 1 + 8 * 4 + 1, "the reload line is not logged every time: " + lines.length);
  console.log(`  OK  offline reloads grow 3/6/10/15 min and cap at 15 (8 h offline = ${reloads.length} reloads, was 160)`);
}

async function testSidebarLiveHintReloadsAtOnceAsBefore() {
  const { reloads, minutes, status, clock } = await world();
  await minutes(3 + 6 + 10); // deep into the schedule: the next routine reload is 15 min away
  await minutes(4); // 4 quiet minutes after that reload: the next routine one is 11 minutes away
  const before = reloads.length;
  clock.advanceTo(clock.now + MIN);
  await status(false, { sidebarLive: true }); // the sidebar says live but the page shows offline
  assert.strictEqual(reloads.length, before + 1, "reloaded immediately, not at the end of the 15-minute wait");
  console.log("  OK  the sidebar-live hint still reloads at once");
}

async function testLiveResetsTheSchedule() {
  const { reloads, minutes } = await world();
  await minutes(3 + 6 + 10 + 15); // 4 reloads: now at the 15-minute step
  await minutes(1, true); // seen live
  const n = reloads.length;
  await minutes(3, false); // offline again: first reload after 3 minutes, not 15
  assert.strictEqual(reloads.length, n + 1, "back to the 3-minute step after the channel was live");
  console.log("  OK  seen live -> the next offline spell starts at 3 minutes again");
}

async function testReloadLineIsSummarisedNotRepeated() {
  const { bg, minutes } = await world();
  await minutes(3 + 6 + 10 + 15 * 8); // 2.5 hours offline
  const lines = bg.logLines().filter((l) => /\[bg\] pinned channel xChocoBars - still offline/.test(l));
  const summaries = bg.logLines().filter((l) => /\[summary\] pinned-live:xChocoBars/.test(l));
  assert.strictEqual(lines.length, 1, "the reload line is logged once: " + lines.length);
  assert.ok(summaries.length >= 8, "then a summary every 15 minutes: " + summaries.length);
  console.log(`  OK  the reload line is logged once + ${summaries.length} summaries over 2.5 h offline`);
}

(async () => {
  console.log("Running pinned-channel reload schedule tests (real background.js, fake clock)...\n");
  try {
    await testOfflineReloadIntervalGrows();
    await testSidebarLiveHintReloadsAtOnceAsBefore();
    await testLiveResetsTheSchedule();
    await testReloadLineIsSummarisedNotRepeated();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
