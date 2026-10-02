/**
 * pinned-slots.test.js
 *
 * An offline pinned channel earns nothing, yet it held a tab quota slot (3 of 5 tabs waiting on
 * offline channels while games that could earn were queued). Now, like a pinned channel on the
 * wrong game (0.6.18), an offline pinned tab STAYS open (that is how it notices going live,
 * fast, with no extra checking) but holds no quota slot:
 *   - at most 5 such tabs; more offline entries wait without a tab (no checking at all);
 *   - when one goes live and the quota is full, the current priority mode (list order / expiry
 *     first) decides: it outranks the lowest-ranked entry being watched -> that tab is closed
 *     and the pinned one takes the slot (logged as a swap); it ranks lowest -> nothing is
 *     swapped, its tab waits without a slot until one frees up;
 *   - live -> offline again: back to a non-quota tab, the slot goes to the next queued entry.
 *
 * Flapping protection: a pinned channel must have been live for 2 minutes in an unbroken run of
 * live reports before it may swap anything; an entry that was just swapped out, or that just took
 * a slot, is left alone by swaps for 10 minutes (going offline still frees the slot at once).
 *
 * Real background.js with an in-memory tabs registry and a fake clock; the pages' reports are
 * sent as the content script sends them (`pinnedChannelStatus`).
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const HOUR = 3_600_000;
const MIN = 60_000;

function makeWorld(storage) {
  const storageData = {
    enabled: true, autoWatchEnabled: true, tabQuota: 2,
    openCampaigns: { fetchedAt: Date.now(), bySlug: {} },
    ...storage,
  };
  const listeners = [];
  const tabsById = new Map();
  let nextTabId = 1;
  let created = 0;
  let nowMs = Date.now();
  const FakeDate = function (...a) { return a.length ? new Date(...a) : new Date(nowMs); };
  FakeDate.now = () => nowMs;
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    Date: FakeDate,
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
        onChanged: { addListener: () => {} },
      },
      runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, getManifest: () => ({ version: "0.0.0-test" }) },
      tabs: {
        create: (opts) => { const id = nextTabId++; created++; tabsById.set(id, { url: opts.url }); return Promise.resolve({ id }); },
        update: () => Promise.resolve(),
        remove: (id) => (tabsById.delete(id) ? Promise.resolve() : Promise.reject(new Error("no such tab"))),
        get: (id) => (tabsById.has(id) ? Promise.resolve({ id, ...tabsById.get(id) }) : Promise.reject(new Error("no such tab"))),
        query: () => Promise.resolve([]),
        reload: () => {},
      },
      alarms: { create: () => {}, clear: () => Promise.resolve(true), onAlarm: { addListener: () => {} } },
      browserAction: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
      downloads: { download: () => Promise.resolve(1), search: () => Promise.resolve([{ state: "complete", filename: "x" }]) },
    },
    URL: globalThis.URL,
    Blob: globalThis.Blob,
  };
  require("./window-stubs").attachWindowApis(sandbox.browser, { createTab: (o) => sandbox.browser.tabs.create({ ...o, active: false }) });
  const ctx = vm.createContext(sandbox);
  const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));
  return {
    ctx, storageData, tabsById, flush, listeners,
    get created() { return created; },
    advance(ms) { nowMs += ms; },
    tabs: () => Object.keys(storageData.watchTabs || {}),
    idle: () => Object.keys(storageData.idlePinned || {}).filter((k) => storageData.idlePinned[k]).sort(),
    logs: () => vm.runInContext("debugLogBuffer.slice()", ctx),
    async boot() {
      vm.runInContext(read("shared.js"), ctx);
      vm.runInContext(read("i18n.js"), ctx);
      vm.runInContext(read("background.js"), ctx);
      await flush(80);
    },
    // what the page of this entry's tab reports to the background
    async report(slug, live) {
      const entry = storageData.watchList.find((g) => g.slug === slug);
      const tabId = storageData.watchTabs[slug];
      assert.ok(tabId != null, `${slug} has a tab to report from`);
      await listeners[0]({ type: "pinnedChannelStatus", channel: entry.channel, live }, { tab: { id: tabId } });
      await flush();
    },
    async tick() { await vm.runInContext("serialized(autoWatchTick)", ctx); await flush(); },
  };
}

const pin = (name) => ({ input: `@${name}`, slug: `channel:${name}`, channel: name, pinnedChannel: true });
const game = (slug) => ({ input: slug, slug });

async function testOfflinePinnedTabsHoldNoSlot() {
  const w = makeWorld({ tabQuota: 2, watchList: [pin("a"), pin("b"), game("x"), game("y")] });
  await w.boot();
  assert.deepStrictEqual(w.tabs().sort(), ["channel:a", "channel:b"], "first both pinned entries fill the quota");
  await w.report("channel:a", false);
  await w.report("channel:b", false);
  assert.deepStrictEqual(w.tabs().sort(), ["channel:a", "channel:b", "x", "y"], "offline pinned tabs stay open, and the two games get the slots");
  assert.deepStrictEqual(w.idle(), ["channel:a", "channel:b"], "the offline ones are marked as holding no slot");
  assert.ok(w.logs().some((l) => /pinned channel a is offline - its tab stays open but no longer holds a quota slot/.test(l)));
  console.log("  OK  offline pinned entries keep their tab but do not take a quota slot (games get them)");
}

async function testAtMostFiveOfflineTabsTheRestWaitWithoutATab() {
  const names = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  const w = makeWorld({ tabQuota: 1, watchList: [...names.map(pin), game("g")] });
  await w.boot();
  for (const n of names) {
    const slug = `channel:${n}`;
    if (w.storageData.watchTabs[slug] == null) continue; // closed by the cap / not opened
    await w.report(slug, false);
  }
  const expected = ["channel:p1", "channel:p2", "channel:p3", "channel:p4", "channel:p5"];
  assert.deepStrictEqual(w.idle(), expected, "the five highest-priority offline tabs stay: " + w.idle());
  assert.deepStrictEqual(w.tabs().sort(), [...expected, "g"].sort(), "the sixth and seventh wait without a tab; the game has the slot: " + w.tabs());
  const createdBefore = w.created;
  await w.tick(); await w.tick(); await w.tick();
  assert.strictEqual(w.created, createdBefore, "no tab is opened to check on them: no extra activity");
  assert.ok(w.logs().some((l) => /more than 5 pinned tabs are waiting without a slot/.test(l)), "and the log says why");
  console.log("  OK  at most 5 offline tabs; the others wait without a tab and are not checked");
}

async function testLiveOutranksLowestWatchedEntryAndSwaps(mode) {
  // quota 2: a pinned (offline, idle), x and y watched; a goes live and outranks y (the lowest)
  const soon = Date.now() + 1 * HOUR, mid = Date.now() + 48 * HOUR, late = Date.now() + 72 * HOUR;
  const progress = (t) => ({ allComplete: false, expired: false, claimed: 0, total: 1, expiresAt: t, updatedAt: 1 });
  const w = makeWorld({
    tabQuota: 2, priorityMode: mode,
    watchList: [pin("a"), game("x"), game("y")],
    // expiry mode: a expires first; list-order mode: a is first in the list
    campaignProgress: { "channel:a": progress(soon), x: progress(mid), y: progress(late) },
  });
  await w.boot();
  await w.report("channel:a", false);
  assert.deepStrictEqual(w.tabs().sort(), ["channel:a", "x", "y"], "x and y hold the two slots, a waits offline");
  await w.report("channel:a", true);
  assert.deepStrictEqual(w.tabs().sort(), ["channel:a", "x", "y"], "not at once: it has to stay live for 2 minutes first");
  w.advance(2 * MIN + 1000);
  await w.tick();
  assert.deepStrictEqual(w.tabs().sort(), ["channel:a", "x"], `${mode}: the lowest-ranked watched entry (y) is closed: ` + w.tabs());
  assert.deepStrictEqual(w.idle(), [], "a holds a slot now");
  const swap = w.logs().filter((l) => /slot swap/.test(l));
  assert.strictEqual(swap.length, 1, "one clear log line");
  assert.ok(new RegExp(`slot swap \\(${mode}\\).*pinned channel a went live and ranks above y.*closed the tab of y`).test(swap[0]), swap[0]);
  console.log(`  OK  ${mode}: a live pinned channel that outranks the lowest watched entry swaps it out (logged)`);
}

async function testLiveButLowestRankTakesNothing(mode) {
  const soon = Date.now() + 1 * HOUR, mid = Date.now() + 48 * HOUR, late = Date.now() + 72 * HOUR, never = Date.now() + 240 * HOUR;
  const progress = (t) => ({ allComplete: false, expired: false, claimed: 0, total: 1, expiresAt: t, updatedAt: 1 });
  // a is opened first (list order puts it first at start) and goes offline; then the ranking changes so that it is last
  const w = makeWorld({
    tabQuota: 2, priorityMode: "list-order",
    watchList: [pin("a"), game("x"), game("y")],
    campaignProgress: { "channel:a": progress(soon), x: progress(mid), y: progress(late) },
  });
  await w.boot();
  await w.report("channel:a", false);
  // now a ranks last in the mode under test
  if (mode === "list-order") w.storageData.watchList = [game("x"), game("y"), pin("a")];
  else { w.storageData.priorityMode = "expiry"; w.storageData.campaignProgress = { "channel:a": progress(never), x: progress(mid), y: progress(late) }; }
  await w.tick();
  const before = w.tabs().sort();
  assert.deepStrictEqual(before, ["channel:a", "x", "y"]);
  await w.report("channel:a", true);
  w.advance(2 * MIN + 1000); // live long enough to be allowed to swap - it just does not outrank anything
  await w.tick();
  assert.deepStrictEqual(w.tabs().sort(), before, `${mode}: nothing is closed for it`);
  assert.deepStrictEqual(w.idle(), ["channel:a"], "its tab stays open as a non-quota tab");
  assert.ok(!w.logs().some((l) => /slot swap/.test(l)), "no swap");
  assert.ok(w.logs().some((l) => /it ranks below every entry that may be swapped/.test(l)), "logged why it waits");

  // until a slot frees up: x is finished -> a is promoted
  w.storageData.campaignProgress = { ...w.storageData.campaignProgress, x: { allComplete: true, expired: false, claimed: 1, total: 1, updatedAt: 2 } };
  await w.tick();
  assert.deepStrictEqual(w.idle(), [], `${mode}: a takes the freed slot`);
  assert.deepStrictEqual(w.tabs().sort(), ["channel:a", "y"]);
  assert.ok(w.logs().some((l) => /pinned channel a went live - takes a free quota slot/.test(l)));
  console.log(`  OK  ${mode}: a live pinned channel that ranks lowest swaps nothing and waits until a slot frees up`);
}

async function testLiveToOfflineFreesTheSlot() {
  const w = makeWorld({ tabQuota: 1, watchList: [pin("a"), game("x")] });
  await w.boot();
  assert.deepStrictEqual(w.tabs(), ["channel:a"], "a holds the only slot, x is queued");
  await w.report("channel:a", true);
  assert.deepStrictEqual(w.tabs(), ["channel:a"], "live: it keeps it");
  await w.report("channel:a", false);
  assert.deepStrictEqual(w.tabs().sort(), ["channel:a", "x"], "live -> offline: the slot goes to the next entry, a's tab stays");
  assert.deepStrictEqual(w.idle(), ["channel:a"]);
  // and back: a outranks x (list order), so x makes room
  await w.report("channel:a", true);
  w.advance(2 * MIN + 1000);
  await w.tick();
  assert.deepStrictEqual(w.tabs(), ["channel:a"], "offline -> live (and live for 2 minutes): it outranks x and swaps it out again");
  console.log("  OK  live -> offline frees the slot for the next entry; live again takes it back");
}

async function testLoadingBlipDoesNotChangeWhoHoldsASlot() {
  const w = makeWorld({ tabQuota: 1, watchList: [pin("a"), game("x")] });
  await w.boot();
  await w.report("channel:a", false);
  await w.report("channel:a", null); // the page is reloading
  assert.deepStrictEqual(w.idle(), ["channel:a"], "still idle while the reloaded page has not said anything");
  assert.deepStrictEqual(w.tabs().sort(), ["channel:a", "x"]);
  console.log("  OK  a reloading page (no verdict yet) changes nothing");
}


// ---- flapping protection ---------------------------------------------------------------------------------------
async function testLiveForAShortWhileThenOfflineSwapsNothing() {
  const w = makeWorld({ tabQuota: 2, watchList: [pin("a"), game("x"), game("y")] });
  await w.boot();
  await w.report("channel:a", false);
  const before = w.tabs().sort();
  assert.deepStrictEqual(before, ["channel:a", "x", "y"]);

  await w.report("channel:a", true);
  w.advance(30_000);
  await w.tick();
  assert.deepStrictEqual(w.tabs().sort(), before, "live for 30 s: no swap");
  assert.ok(w.logs().some((l) => /live for only \d+ s of the 120 s needed/.test(l)), "and the log says it is waiting");
  await w.report("channel:a", false); // gone again
  w.advance(5 * MIN);
  await w.tick();
  assert.deepStrictEqual(w.tabs().sort(), before, "offline again: still nothing swapped");
  assert.ok(!w.logs().some((l) => /slot swap/.test(l)), "no swap was made");

  // a new live run starts its 2 minutes from the beginning
  await w.report("channel:a", true);
  w.advance(MIN);
  await w.tick();
  assert.deepStrictEqual(w.tabs().sort(), before, "the earlier short run does not count");
  w.advance(MIN + 1000);
  await w.tick();
  assert.deepStrictEqual(w.tabs().sort(), ["channel:a", "x"], "after 2 minutes live in a row it swaps");
  console.log("  OK  live for 30 s then offline: no swap; the 2 minutes must be one unbroken run");
}

async function testNoSwapBackWithinTenMinutes() {
  // quota 1: a outranks b. b holds the slot (a offline); a goes live and swaps b out; a goes offline (b comes back);
  // a is live again within 10 minutes of the swap: no swap back
  const w = makeWorld({ tabQuota: 1, watchList: [pin("a"), pin("b")] });
  await w.boot();
  await w.report("channel:a", false); // a idle, b opens
  await w.report("channel:b", true);
  await w.report("channel:a", true);
  w.advance(2 * MIN + 1000);
  await w.tick();
  assert.deepStrictEqual(w.tabs(), ["channel:a"], "first swap: a takes the slot from b");
  assert.strictEqual(w.logs().filter((l) => /slot swap/.test(l)).length, 1);

  await w.report("channel:a", false); // a goes offline: the slot is freed, b is back
  assert.deepStrictEqual(w.tabs().sort(), ["channel:a", "channel:b"], "offline frees the slot at once, as before");
  await w.report("channel:b", true);
  await w.report("channel:a", true); // a is live again, ~2 minutes after the swap
  w.advance(2 * MIN + 1000);
  await w.tick();
  assert.deepStrictEqual(w.tabs().sort(), ["channel:a", "channel:b"], "within 10 minutes: no swap back");
  assert.strictEqual(w.logs().filter((l) => /slot swap/.test(l)).length, 1, "no second swap");
  assert.ok(w.logs().some((l) => /changed slots less than 10 minutes ago/.test(l)));

  w.advance(8 * MIN); // ~10 minutes and a bit since the first swap
  await w.tick();
  assert.deepStrictEqual(w.tabs(), ["channel:a"], "after the cooldown the higher-ranked channel may swap again");
  assert.strictEqual(w.logs().filter((l) => /slot swap/.test(l)).length, 2);
  console.log("  OK  swapped in, the other side live again within 10 minutes: no swap back; allowed afterwards");
}

async function testAnEntryThatJustTookASlotIsNotSwappedOut() {
  // quota 1, ranking c > a > b. b watched; a swaps b out; then c (outranks a) goes live: a just took a slot -> left alone
  const w = makeWorld({ tabQuota: 1, watchList: [pin("c"), pin("a"), pin("b")] });
  await w.boot();
  await w.report("channel:c", false); // c idle, a opens
  await w.report("channel:a", false); // a idle, b opens
  await w.report("channel:b", true);
  await w.report("channel:a", true);
  w.advance(2 * MIN + 1000);
  await w.tick();
  assert.deepStrictEqual(w.tabs().sort(), ["channel:a", "channel:c"], "a swapped b out");

  await w.report("channel:c", true);
  w.advance(2 * MIN + 1000);
  await w.tick();
  assert.deepStrictEqual(w.tabs().sort(), ["channel:a", "channel:c"], "c outranks a, but a took its slot minutes ago: not swapped out");
  assert.deepStrictEqual(w.idle(), ["channel:c"]);
  assert.ok(w.logs().some((l) => /every entry being watched changed slots less than 10 minutes ago/.test(l)));

  w.advance(10 * MIN);
  await w.tick();
  assert.deepStrictEqual(w.tabs(), ["channel:c"], "after the cooldown c swaps a");
  console.log("  OK  an entry that just took a slot is not swapped out for 10 minutes");
}

(async () => {
  console.log("Running pinned slot tests (real background.js, in-memory tabs)...\n");
  try {
    await testOfflinePinnedTabsHoldNoSlot();
    await testAtMostFiveOfflineTabsTheRestWaitWithoutATab();
    await testLiveOutranksLowestWatchedEntryAndSwaps("list-order");
    await testLiveOutranksLowestWatchedEntryAndSwaps("expiry");
    await testLiveButLowestRankTakesNothing("list-order");
    await testLiveButLowestRankTakesNothing("expiry");
    await testLiveToOfflineFreesTheSlot();
    await testLoadingBlipDoesNotChangeWhoHoldsASlot();
    await testLiveForAShortWhileThenOfflineSwapsNothing();
    await testNoSwapBackWithinTenMinutes();
    await testAnEntryThatJustTookASlotIsNotSwappedOut();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
