/**
 * session-windows.test.js
 *
 * Firefox numbers window and tab ids from 1 again on every start AND restores
 * last session's windows - including the watch window with its pinned tabs.
 * Live evidence (2026-09-28): the user's session file showed the old watch
 * window restored next to a freshly created one (3 windows on every start),
 * plus two pinned /drops/campaigns tabs left behind by the removed transient
 * campaigns tab. These tests model that against a fake windows/tabs registry:
 *   - a new browser session forgets remembered tab/window ids (they can equal
 *     the user's own window/tab ids);
 *   - a restored window that looks like ours is adopted, not duplicated, and
 *     its stale tabs are closed;
 *   - later-restored look-alike windows and leftover pinned campaigns tabs
 *     are swept, the user's own windows never are.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const INV = "https://www.twitch.tv/drops/inventory";
const CAMP = "https://www.twitch.tv/drops/campaigns";

function makeWorld({ session = "none", local = {}, windows, tabs }) {
  const storageLocal = {
    enabled: true, autoWatchEnabled: true, tabQuota: 3,
    watchList: [{ input: "warframe", slug: "warframe" }],
    ...local,
  };
  const storageSession = session === "none" ? null : { ...(session || {}) };
  const winMap = new Map(windows.map((id) => [id, { id, type: "normal", focused: false }]));
  const tabMap = new Map(tabs.map((t) => [t.id, { active: false, muted: false, ...t }]));
  let nextWin = 100;
  let nextTab = 1000;
  const created = { windows: [], tabs: [] };
  const removed = { windows: [], tabs: [] };

  const pat = (p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  const store = (data) => ({
    get: (keys) => {
      if (keys == null) return Promise.resolve({ ...data });
      if (typeof keys === "string") return Promise.resolve({ [keys]: data[keys] });
      const out = {};
      for (const k of keys) out[k] = data[k];
      return Promise.resolve(out);
    },
    set: (obj) => { Object.assign(data, obj); return Promise.resolve(); },
  });

  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, URL: globalThis.URL, Blob: globalThis.Blob,
    browser: {
      storage: {
        local: store(storageLocal),
        ...(storageSession ? { session: store(storageSession) } : {}),
        onChanged: { addListener: () => {} },
      },
      runtime: { onMessage: { addListener: () => {} }, getManifest: () => ({ version: "0.0.0-test" }) },
      windows: {
        get: (id) => (winMap.has(id) ? Promise.resolve({ ...winMap.get(id) }) : Promise.reject(new Error("no such window"))),
        getAll: (opts = {}) => Promise.resolve([...winMap.values()].map((w) => ({
          ...w,
          ...(opts.populate ? { tabs: [...tabMap.values()].filter((t) => t.windowId === w.id).map((t) => ({ ...t })) } : {}),
        }))),
        create: () => {
          const id = nextWin++;
          winMap.set(id, { id, type: "normal", focused: true });
          const tid = nextTab++;
          tabMap.set(tid, { id: tid, windowId: id, url: "about:blank", pinned: false, active: true, muted: false });
          created.windows.push(id);
          return Promise.resolve({ id, tabs: [{ id: tid, windowId: id }] });
        },
        remove: (id) => {
          if (!winMap.has(id)) return Promise.reject(new Error("no such window"));
          winMap.delete(id);
          for (const [tid, t] of [...tabMap]) if (t.windowId === id) tabMap.delete(tid);
          removed.windows.push(id);
          return Promise.resolve();
        },
      },
      tabs: {
        create: (opts) => {
          const id = nextTab++;
          tabMap.set(id, { id, windowId: opts.windowId != null ? opts.windowId : 1, url: opts.url, pinned: !!opts.pinned, active: false, muted: false });
          created.tabs.push({ id, url: opts.url, windowId: opts.windowId });
          return Promise.resolve({ id, windowId: opts.windowId });
        },
        update: (id, opts) => { const t = tabMap.get(id); if (t) Object.assign(t, opts); return Promise.resolve(); },
        remove: (id) => {
          if (!tabMap.has(id)) return Promise.reject(new Error("no such tab"));
          tabMap.delete(id); removed.tabs.push(id);
          return Promise.resolve();
        },
        get: (id) => (tabMap.has(id) ? Promise.resolve({ ...tabMap.get(id) }) : Promise.reject(new Error("no such tab"))),
        query: (q = {}) => Promise.resolve([...tabMap.values()].filter((t) =>
          (q.url == null || pat(q.url).test(t.url || "")) &&
          (q.windowId == null || t.windowId === q.windowId) &&
          (q.pinned == null || !!t.pinned === q.pinned)).map((t) => ({ ...t }))),
        reload: () => {},
      },
      alarms: { create: () => {}, clear: () => Promise.resolve(true), onAlarm: { addListener: () => {} } },
      browserAction: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
      downloads: { download: () => Promise.resolve(1), search: () => Promise.resolve([]) },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  const flush = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  return {
    ctx, storageLocal, storageSession, winMap, tabMap, created, removed, flush,
    boot: async () => { vm.runInContext(read("background.js"), ctx); await flush(150); },
    tick: async () => { await vm.runInContext("serialized(autoWatchTick)", ctx); await flush(); },
    tabsIn: (winId) => [...tabMap.values()].filter((t) => t.windowId === winId),
  };
}

// last session's watch window (1) restored next to the user's own window (2)
const restoredSession = () => ({
  windows: [1, 2],
  tabs: [
    { id: 1, windowId: 1, url: INV, pinned: true },
    { id: 2, windowId: 1, url: "https://www.twitch.tv/somechannel", pinned: true },
    { id: 3, windowId: 1, url: CAMP, pinned: true },
    { id: 7, windowId: 1, url: "about:home", pinned: false }, // windows.create()'s initial tab, as in the real session file
    { id: 4, windowId: 2, url: "https://www.youtube.com/", pinned: false },
    { id: 5, windowId: 2, url: "https://www.twitch.tv/ironmouse", pinned: true },
    { id: 6, windowId: 2, url: CAMP, pinned: false }, // the user's own campaigns tab
  ],
});

async function testRestartAdoptsRestoredWatchWindowAndForgetsStaleIds() {
  const w = makeWorld({
    session: {}, // fresh browser session: nothing stored yet
    local: { watchWindowId: 2, watchTabs: { warframe: 4 }, watchMeta: { warframe: { channel: "x", tabId: 4 } } }, // ids that now belong to the USER's window/tab
    ...restoredSession(),
  });
  await w.boot();

  assert.deepStrictEqual(w.created.windows, [], "no second watch window is opened");
  assert.strictEqual(w.winMap.size, 2, "still exactly the two windows Firefox restored");
  assert.strictEqual(w.storageLocal.watchWindowId, 1, "the restored look-alike window was adopted (not the user's window 2)");

  assert.ok(w.tabMap.has(4) && w.tabMap.has(5) && w.tabMap.has(6), "the user's own tabs are untouched");
  assert.strictEqual(w.tabsIn(2).length, 3, "the user's window keeps all 3 tabs");
  assert.notStrictEqual(w.storageLocal.watchTabs.warframe, 4, "stale watchTabs entry that pointed at the user's tab was dropped");

  const inWatch = w.tabsIn(1);
  assert.ok(!w.tabMap.has(2) && !w.tabMap.has(3) && !w.tabMap.has(7), "stale channel tab, leftover campaigns tab and the about:home tab in the restored window are closed");
  assert.ok(inWatch.some((t) => t.id === 1 && t.url === INV), "the restored inventory tab is kept");
  assert.ok(inWatch.some((t) => /directory\/category\/warframe/.test(t.url)), "the game's tab was opened inside the adopted window");
  assert.strictEqual(w.tabMap.get(w.storageLocal.watchTabs.warframe).windowId, 1);
  console.log("  OK  restart: restored watch window adopted (no 3rd window), stale ids forgotten, user's window/tabs untouched");
}

async function testSameSessionKeepsState() {
  const w = makeWorld({
    session: { tdcSessionStarted: 1 }, // extension script reloaded within the same browser session... marker survived
    local: { watchWindowId: 1, watchTabs: { warframe: 2 }, watchMeta: { warframe: { channel: "somechannel", tabId: 2, watchStartedAt: 1 } } },
    windows: [1, 2],
    tabs: [
      { id: 1, windowId: 1, url: INV, pinned: true },
      { id: 2, windowId: 1, url: "https://www.twitch.tv/somechannel", pinned: true },
      { id: 4, windowId: 2, url: "https://www.youtube.com/", pinned: false },
    ],
  });
  await w.boot();
  assert.strictEqual(w.storageLocal.watchTabs.warframe, 2, "same session: remembered tab id is kept");
  assert.ok(w.tabMap.has(2), "and its tab is not closed");
  assert.deepStrictEqual(w.created.windows, []);
  console.log("  OK  same browser session: remembered ids and tabs are kept");
}

async function testLateRestoredLookalikeWindowIsSwept() {
  const w = makeWorld({
    session: { tdcSessionStarted: 1 },
    local: { watchWindowId: 10 },
    windows: [10, 11, 12],
    tabs: [
      { id: 1, windowId: 10, url: INV, pinned: true },
      { id: 2, windowId: 10, url: CAMP, pinned: true }, // leftover from < 0.6.14
      { id: 3, windowId: 11, url: INV, pinned: true }, // session restore landed after our first tick
      { id: 4, windowId: 11, url: "https://www.twitch.tv/old", pinned: true },
      { id: 5, windowId: 12, url: "https://www.twitch.tv/ironmouse", pinned: true }, // user window, ONLY pinned twitch tabs but no inventory
      { id: 6, windowId: 12, url: "https://www.twitch.tv/black_moon_", pinned: true },
    ],
  });
  await vm.runInContext("void 0", w.ctx);
  vm.runInContext(read("background.js"), w.ctx); // boot (session marker present -> no reset)
  await w.flush(150);
  await w.tick();

  assert.ok(!w.winMap.has(11), "the late-restored look-alike window is closed");
  assert.ok(w.winMap.has(10) && w.winMap.has(12), "our window and the user's pinned-only window stay");
  assert.ok(!w.tabMap.has(2), "the pinned /drops/campaigns leftover in the watch window is closed");
  assert.ok(w.tabMap.has(5) && w.tabMap.has(6), "a user window without an inventory tab is never mistaken for ours");
  console.log("  OK  sweep: late look-alike window + pinned campaigns leftover closed; user's pinned-only window kept");
}

async function testSweepReopensInventoryIfItWasOnlyInTheStaleWindow() {
  const w = makeWorld({
    session: { tdcSessionStarted: 1 },
    local: { watchWindowId: 10 },
    windows: [10, 11],
    tabs: [
      { id: 1, windowId: 10, url: "https://www.twitch.tv/somechannel", pinned: true },
      { id: 3, windowId: 11, url: INV, pinned: true },
      { id: 4, windowId: 11, url: "https://www.twitch.tv/old", pinned: true },
    ],
  });
  vm.runInContext(read("background.js"), w.ctx);
  await w.flush(150);
  await w.tick();
  assert.ok(!w.winMap.has(11), "stale window closed");
  const inv = [...w.tabMap.values()].filter((t) => /drops\/inventory/.test(t.url));
  assert.strictEqual(inv.length, 1, "exactly one inventory tab exists afterwards");
  assert.strictEqual(inv[0].windowId, 10, "and it lives in our watch window");
  console.log("  OK  sweep: the inventory tab is reopened in the watch window when the stale window held the only one");
}

async function testSignatureBoundaries() {
  const cases = [
    ["unpinned inventory + pinned channels (a restored freshly-created window)", true, [
      { id: 1, windowId: 5, url: INV, pinned: false },
      { id: 2, windowId: 5, url: "https://www.twitch.tv/somechannel", pinned: true },
    ]],
    ["pinned inventory + about:home", true, [
      { id: 1, windowId: 5, url: INV, pinned: true },
      { id: 2, windowId: 5, url: "about:home", pinned: false },
    ]],
    ["an ordinary tab makes it the user's window", false, [
      { id: 1, windowId: 5, url: INV, pinned: true },
      { id: 2, windowId: 5, url: "https://www.youtube.com/", pinned: false },
    ]],
    ["the user's own unpinned twitch tab makes it theirs", false, [
      { id: 1, windowId: 5, url: INV, pinned: true },
      { id: 2, windowId: 5, url: "https://www.twitch.tv/somechannel", pinned: false },
    ]],
    ["an extension page (popup opened in a tab) makes it theirs", false, [
      { id: 1, windowId: 5, url: INV, pinned: true },
      { id: 2, windowId: 5, url: "moz-extension://abc/popup.html", pinned: false },
    ]],
    ["only a lone unpinned inventory tab (the user looking at it) is not enough", false, [
      { id: 1, windowId: 5, url: INV, pinned: false },
    ]],
    ["no inventory at all", false, [
      { id: 1, windowId: 5, url: "https://www.twitch.tv/a", pinned: true },
      { id: 2, windowId: 5, url: "https://www.twitch.tv/b", pinned: true },
    ]],
  ];
  for (const [label, expected, tabs] of cases) {
    // enabled:false so loading background.js does no scheduling of its own while we look
    const w = makeWorld({ session: { tdcSessionStarted: 1 }, local: { enabled: false }, windows: [5], tabs });
    vm.runInContext(read("background.js"), w.ctx);
    await w.flush(30);
    const found = await vm.runInContext("findWatchWindowCandidates", w.ctx)();
    assert.strictEqual(found.length === 1, expected, label);
  }
  console.log("  OK  window signature: restored/blank-tab variants match; any ordinary, extension or lone tab never does");
}

async function testLoneInventoryWindowIsAdoptedButNeverClosed() {
  // after an extension reload the old watch window holds just its inventory tab
  const adopt = makeWorld({
    session: {}, // reload cleared the session marker
    local: { watchWindowId: 5 },
    windows: [5],
    tabs: [{ id: 1, windowId: 5, url: INV, pinned: false }],
  });
  await adopt.boot();
  assert.deepStrictEqual(adopt.created.windows, [], "no extra window opened next to the old lone-inventory window");
  assert.strictEqual(adopt.storageLocal.watchWindowId, 5, "the lone-inventory window was adopted");
  assert.ok(adopt.tabMap.has(1), "its inventory tab is kept");

  // ...but the sweep (which CLOSES windows) never treats such a window as stale
  const sweep = makeWorld({
    session: { tdcSessionStarted: 1 },
    local: { watchWindowId: 10 },
    windows: [10, 20],
    tabs: [
      { id: 1, windowId: 10, url: INV, pinned: true },
      { id: 2, windowId: 20, url: INV, pinned: false }, // the user reading their inventory in a window of its own
    ],
  });
  vm.runInContext(read("background.js"), sweep.ctx);
  await sweep.flush(150);
  await sweep.tick();
  assert.ok(sweep.winMap.has(20), "a user's lone-inventory window is never closed");
  console.log("  OK  a lone-inventory window is adopted after a reload, and never closed by the sweep");
}

async function testNoSessionStorageKeepsOldBehaviour() {
  const w = makeWorld({
    session: "none",
    local: { watchWindowId: 1, watchTabs: { warframe: 2 } },
    windows: [1],
    tabs: [
      { id: 1, windowId: 1, url: INV, pinned: true },
      { id: 2, windowId: 1, url: "https://www.twitch.tv/directory/category/warframe?filter=drops", pinned: true },
    ],
  });
  await w.boot();
  assert.strictEqual(w.storageLocal.watchTabs.warframe, 2, "without storage.session nothing is reset");
  assert.deepStrictEqual(w.created.windows, []);
  console.log("  OK  a Firefox without storage.session behaves exactly as before");
}

(async () => {
  console.log("Running session/window tests (no real browser, no network)...\n");
  try {
    await testRestartAdoptsRestoredWatchWindowAndForgetsStaleIds();
    await testSameSessionKeepsState();
    await testLateRestoredLookalikeWindowIsSwept();
    await testSweepReopensInventoryIfItWasOnlyInTheStaleWindow();
    await testSignatureBoundaries();
    await testLoneInventoryWindowIsAdoptedButNeverClosed();
    await testNoSessionStorageKeepsOldBehaviour();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
