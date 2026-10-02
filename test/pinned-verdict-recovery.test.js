/**
 * pinned-verdict-recovery.test.js
 *
 * Real 0.6.21 report (issue #10): pinned channels sat in "checking the channel..." for hours
 * (one of them live), neither idle (offline) nor counted (live), never flashed.
 *
 *  1. The record of what a pinned page reported (`pinnedLive`) was lost when two pages reported in
 *     the same instant (each read the whole object and wrote it back; reloads of two tabs were
 *     43 ms apart in the report) - and an in-memory "already written" guard then never wrote it
 *     again. Writes are serialised now and the STORED record decides whether a write is needed
 *     (a lost record comes back with the next report).
 *  2. The whole path - real content.js on a channel page -> real background.js, with the real
 *     "channel:<name>" key - records live/offline for the right tab, flashes a live one.
 *  3. Safety net: a pinned tab with no live/offline verdict for 10 minutes is reloaded ONCE (logged,
 *     with what the page looked like); still none 10 minutes later -> "live unknown": treated as
 *     watched and flashed (again every 10 minutes while it stays unknown), the way pinned tabs
 *     worked before 0.6.20. A real verdict takes over at any time.
 */

const vm = require("vm");
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { MIN, flush, read, makeClock, makeBackground } = require("./claim-harness");

const entry = (name) => ({ input: `@${name}`, slug: `channel:${name.toLowerCase()}`, channel: name, pinnedChannel: true });

async function world(names, tabOf) {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const flashes = [];
  const reloads = [];
  vm.runInContext(`
    getOrCreateWatchWindow = async () => ({ id: 100, freshlyCreated: false });
    flashTabToStartPlayback = async (id) => { __flashes.push([id, Date.now()]); };
    browser.tabs.get = async (id) => ({ id, windowId: 100 });
    browser.tabs.reload = async (id) => { __reloads.push([id, Date.now()]); };
  `, Object.assign(bg.ctx, { __flashes: flashes, __reloads: reloads }));
  bg.local.enabled = true;
  bg.local.autoWatchEnabled = true;
  bg.local.openCampaigns = { fetchedAt: clock.now, bySlug: {} };
  bg.local.watchList = names.map(entry);
  bg.local.watchTabs = Object.fromEntries(names.map((n) => [`channel:${n.toLowerCase()}`, tabOf(n)]));
  bg.local.watchMeta = Object.fromEntries(names.map((n) => [`channel:${n.toLowerCase()}`, { channel: n, tabId: tabOf(n), watchStartedAt: clock.now }]));
  const report = (name, live, extra = {}) => bg.send({ type: "pinnedChannelStatus", channel: name, live, ...extra }, tabOf(name));
  const tick = async () => { await vm.runInContext("serialized(autoWatchTick)", bg.ctx); await flush(); };
  const rec = (name) => (bg.local.pinnedLive || {})[`channel:${name.toLowerCase()}`];
  return { clock, bg, flashes, reloads, report, tick, rec };
}
const ID = { DisguisedToast: 72, Blooprint: 73, GEEGA: 74 };
const tabOf = (n) => ID[n];

async function testReportsInTheSameInstantAreAllKept() {
  const names = ["DisguisedToast", "Blooprint", "GEEGA"];
  const w = await world(names, tabOf);
  // the three pages report on the same beat, as in the report
  await Promise.all([w.report("DisguisedToast", false), w.report("GEEGA", false), w.report("Blooprint", true)]);
  await flush();
  assert.deepStrictEqual(names.map((n) => w.rec(n) && w.rec(n).state), ["offline", "live", "offline"], "every page's verdict is recorded: " + JSON.stringify(w.bg.local.pinnedLive));
  assert.deepStrictEqual(names.map((n) => w.rec(n) && w.rec(n).tabId), [72, 73, 74]);
  console.log("  OK  three pages reporting in the same instant: none of the records is lost");
}

async function testALostRecordComesBackWithTheNextReport() {
  const w = await world(["GEEGA"], tabOf);
  await w.report("GEEGA", false);
  assert.strictEqual(w.rec("GEEGA").state, "offline");
  delete w.bg.local.pinnedLive["channel:geega"]; // lost (whatever the cause)
  await w.report("GEEGA", false); // the page still says offline
  assert.strictEqual(w.rec("GEEGA") && w.rec("GEEGA").state, "offline", "written again: the stored record decides, not a memory of having written it");
  // and a record for another tab id (a replaced tab) is replaced too
  w.bg.local.pinnedLive["channel:geega"] = { tabId: 999, state: "live", at: 1 };
  await w.report("GEEGA", false);
  assert.deepStrictEqual({ tabId: w.rec("GEEGA").tabId, state: w.rec("GEEGA").state }, { tabId: 74, state: "offline" });
  console.log("  OK  a lost / stale record is rewritten by the next report");
}

// ---- the whole path: real content.js on a channel page -> real background.js -----------------------------
async function channelPage(w, name, html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: `https://www.twitch.tv/${name.toLowerCase()}` });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  const intervals = [];
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    Set, Map, Promise, URL, JSON, Math, Array, Object, Number, String, RegExp,
    Date: w.clock.FakeDate,
    window, document: window.document, location: window.location,
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {},
    setTimeout: (fn, ms) => w.clock.setTimeout(fn, ms), clearTimeout: (t) => w.clock.clearTimeout(t),
    browser: {
      storage: { local: { get: () => Promise.resolve({ enabled: true, gameIdMap: {} }), set: () => Promise.resolve() }, onChanged: { addListener() {} } },
      runtime: { sendMessage: (m) => w.bg.send(m, tabOf(name)), onMessage: { addListener() {} } },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext(read("content.js"), ctx);
  await flush();
  // the page's 60 s beat
  return async () => { for (const i of intervals.filter((x) => x.ms === 60_000)) await i.fn(); await flush(); await flush(); };
}

const LIVE_PAGE = '<div data-a-target="animated-channel-viewers-count">1.2K</div><a data-a-target="stream-game-link" href="/directory/category/rust">Rust</a>';
const OFFLINE_PAGE = '<div class="channel-root__player--offline">offline</div>';
const NO_VERDICT_PAGE = '<div>just a page with no markers</div>';

async function testWholePathFromContentToBackgroundWithTheRealKey() {
  const w = await world(["Blooprint"], tabOf);
  const beat = await channelPage(w, "Blooprint", LIVE_PAGE);
  await beat();
  const r = w.rec("Blooprint");
  assert.ok(r, "content.js's report reached pinnedLive under the key channel:blooprint: " + JSON.stringify(w.bg.local.pinnedLive));
  assert.deepStrictEqual({ tabId: r.tabId, state: r.state }, { tabId: 73, state: "live" }, "for the right tab, as live");
  assert.deepStrictEqual(w.flashes.map((f) => f[0]), [73], "a live pinned page gets its tab flashed so the player starts");

  const off = await world(["GEEGA"], tabOf);
  await (await channelPage(off, "GEEGA", OFFLINE_PAGE))();
  assert.strictEqual(off.rec("GEEGA").state, "offline");
  assert.deepStrictEqual(Object.keys(off.bg.local.idlePinned || {}), ["channel:geega"], "an offline page is marked idle (no quota slot) by the scheduler");
  assert.strictEqual(off.flashes.length, 0, "no flash for an offline page");

  const none = await world(["DisguisedToast"], tabOf);
  await (await channelPage(none, "DisguisedToast", NO_VERDICT_PAGE))();
  assert.strictEqual(none.rec("DisguisedToast").state, "loading", "a page with no markers reports no verdict");
  console.log("  OK  content.js -> background.js: live / offline / no verdict are recorded for the right tab under 'channel:<name>'; live is flashed, offline is idle");
}

// ---- safety net -----------------------------------------------------------------------------------------------
async function testStuckWithoutAVerdictIsReloadedOnceThenTreatedAsLiveUnknown() {
  const w = await world(["DisguisedToast"], tabOf);
  const beat = await channelPage(w, "DisguisedToast", NO_VERDICT_PAGE);
  const step = async (ms) => { w.clock.advanceTo(w.clock.now + ms); await beat(); await w.tick(); };

  await beat(); // the first report: no verdict
  await w.tick();
  await step(9 * MIN);
  assert.strictEqual(w.reloads.length, 0, "9 minutes: not yet");
  await step(2 * MIN);
  assert.strictEqual(w.reloads.filter((r) => r[0] === 72).length, 1, "after 10 minutes without a verdict: its tab is reloaded once");
  const line = w.bg.logLines().find((l) => /has had no live\/offline verdict for \d+ min/.test(l) && /reloading its tab once/.test(l));
  assert.ok(line && /"gate":false/.test(line) && /"textLen":/.test(line), "logged clearly, with what the page looked like: " + line);
  await step(2 * MIN);
  assert.strictEqual(w.reloads.length, 1, "never a second reload");
  assert.strictEqual(w.flashes.length, 0, "not flashed yet");

  await step(9 * MIN); // 10 minutes after the reload, still nothing
  assert.strictEqual(w.rec("DisguisedToast").state, "unknown", "declared live-unknown");
  assert.deepStrictEqual(w.flashes.map((f) => f[0]), [72], "and flashed so the stream gets a chance to play");
  assert.ok(w.bg.logLines().some((l) => /still has no verdict .*treating it as live \(unknown\) and flashing its tab/.test(l)));
  await step(3 * MIN); // the page keeps reporting no verdict: it stays unknown (is not flipped back to "checking")
  assert.strictEqual(w.rec("DisguisedToast").state, "unknown");
  assert.strictEqual(w.flashes.length, 1, "not flashed again within 10 minutes");
  await step(8 * MIN);
  assert.strictEqual(w.flashes.length, 2, "flashed again after 10 minutes while still unknown");
  assert.strictEqual(w.reloads.length, 1, "still only the one reload");
  console.log("  OK  no verdict for 10 min -> one logged reload; 10 min later -> live unknown + flash (again every 10 min); never a second reload");
}

async function testARealVerdictTakesOverFromUnknown() {
  const w = await world(["GEEGA"], tabOf);
  await w.report("GEEGA", null, { diag: { gate: false, ready: "complete", visible: "hidden", textLen: 10, player: false, path: "/geega" } });
  w.clock.advanceTo(w.clock.now + 10.5 * MIN); await w.tick();
  w.clock.advanceTo(w.clock.now + 10.5 * MIN); await w.tick();
  assert.strictEqual(w.rec("GEEGA").state, "unknown");
  await w.report("GEEGA", false);
  assert.strictEqual(w.rec("GEEGA").state, "offline", "the page finally says offline: that is the state");
  await w.tick();
  assert.deepStrictEqual(Object.keys(w.bg.local.idlePinned || {}), ["channel:geega"]);
  w.clock.advanceTo(w.clock.now + 30 * MIN); await w.tick();
  assert.strictEqual(w.bg.logLines().filter((l) => /no live\/offline verdict for/.test(l)).length, 1, "the safety net does not fire again once there is a verdict");
  console.log("  OK  a real live/offline verdict replaces 'unknown'");
}

async function testAnEntryWithAVerdictIsNotTouchedByTheNet() {
  const w = await world(["Blooprint", "GEEGA"], tabOf);
  await w.report("Blooprint", true);
  await w.report("GEEGA", false);
  w.clock.advanceTo(w.clock.now + 10 * MIN);
  await w.report("Blooprint", true);
  await w.report("GEEGA", false);
  await w.tick();
  assert.strictEqual(w.reloads.filter((r) => /stuck/.test(String(r))).length, 0);
  assert.ok(!w.bg.logLines().some((l) => /no live\/offline verdict/.test(l)), "no stuck handling for pages that gave a verdict");
  console.log("  OK  pages with a verdict are left alone");
}

(async () => {
  console.log("Running pinned verdict recovery tests (real content.js + background.js)...\n");
  try {
    await testReportsInTheSameInstantAreAllKept();
    await testALostRecordComesBackWithTheNextReport();
    await testWholePathFromContentToBackgroundWithTheRealKey();
    await testStuckWithoutAVerdictIsReloadedOnceThenTreatedAsLiveUnknown();
    await testARealVerdictTakesOverFromUnknown();
    await testAnEntryWithAVerdictIsNotTouchedByTheNet();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
