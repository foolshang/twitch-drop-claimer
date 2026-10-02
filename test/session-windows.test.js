/**
 * session-windows.test.js
 *
 * The watch window ("window 2") and the user's windows. Firefox numbers window
 * and tab ids from 1 again on every start AND, after an unclean shutdown
 * (Windows restarting after an update, a power cut, shutting Windows down with
 * Firefox open), restores every window - the old watch window included. Reported
 * in real use of 0.6.18: on switching the extension on, the user's own window
 * ended up with the same tabs as the watch window. 0.6.19:
 *   - window 2 is tagged "dropClaimerWatch" (sessions.setWindowValue) when it is
 *     created; after a restore the TAG says which window is ours - tab
 *     appearance is no longer used, so a user window that merely looks like a
 *     watch window is never adopted or closed;
 *   - every window that is not window 2 is the user's (recorded on switch-on);
 *   - one serialized path finds/creates window 2; every tab is opened with an
 *     explicit windowId = window 2, or not at all - no fallback to the current
 *     window - and waits until window 2 is verified;
 *   - back to square one on a new browser session or when window 2 closes;
 *   - a restored window that arrives late (windows.onCreated) is adopted, not
 *     duplicated; a second tagged window is a leftover, closed only when it
 *     holds nothing but our own tabs.
 * A fake windows/tabs/sessions registry; no browser, no network.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
// short timers for the restore grace and the late-tag rechecks (a no-op against a background.js without them)
const bgSrc = () => read("background.js")
  .replace(/WINDOW_RECHECK_MS = \[[^\]]*\]/, "WINDOW_RECHECK_MS = [20, 60, 140]")
  .replace(/WINDOW_RESTORE_GRACE_MS = [\d_]+/, "WINDOW_RESTORE_GRACE_MS = 150");

const INV = "https://www.twitch.tv/drops/inventory";
const CAMP = "https://www.twitch.tv/drops/campaigns";
const TAG = "dropClaimerWatch";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWorld({ session = "none", local = {}, windows, tabs, sessionsApi = true, createDelay = 0, createFailures = 0 }) {
  const storageLocal = {
    enabled: true, autoWatchEnabled: true, tabQuota: 3,
    watchList: [{ input: "warframe", slug: "warframe" }],
    ...local,
  };
  const storageSession = session === "none" ? null : { ...(session || {}) };
  const winMap = new Map(windows.map((w) => [w.id, { id: w.id, type: "normal", focused: false }]));
  const tags = new Map(windows.filter((w) => w.tagged).map((w) => [w.id, true]));
  const tabMap = new Map(tabs.map((t) => [t.id, { active: false, muted: false, status: "complete", ...t }]));
  let nextWin = 100;
  let nextTab = 1000;
  let createFailuresLeft = createFailures;
  const created = { windows: [], tabs: [] };
  const removed = { windows: [], tabs: [] };
  const events = [];
  const listeners = { windowsCreated: [], windowsRemoved: [], storage: [] };
  const userWindowIds = new Set(windows.filter((w) => !w.tagged).map((w) => w.id)); // what the user owns, for the audit below
  const violations = [];
  const sessionsCalls = [];

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
        onChanged: { addListener: (fn) => listeners.storage.push(fn) },
      },
      runtime: { onMessage: { addListener: () => {} }, getManifest: () => ({ version: "0.0.0-test" }) },
      windows: {
        get: (id) => (winMap.has(id) ? Promise.resolve({ ...winMap.get(id) }) : Promise.reject(new Error("no such window"))),
        getAll: (opts = {}) => Promise.resolve([...winMap.values()].map((w) => ({
          ...w,
          ...(opts.populate ? { tabs: [...tabMap.values()].filter((t) => t.windowId === w.id).map((t) => ({ ...t })) } : {}),
        }))),
        create: async () => {
          events.push("create-start");
          if (createDelay) await sleep(createDelay);
          if (createFailuresLeft > 0) { createFailuresLeft--; events.push("create-failed"); throw new Error("windows.create failed"); }
          const id = nextWin++;
          winMap.set(id, { id, type: "normal", focused: true });
          const tid = nextTab++;
          tabMap.set(tid, { id: tid, windowId: id, url: "about:blank", pinned: false, active: true, muted: false, status: "complete" });
          created.windows.push(id);
          events.push(`create-end:${id}`);
          return { id, type: "normal", tabs: [{ id: tid, windowId: id }] };
        },
        remove: (id) => {
          if (!winMap.has(id)) return Promise.reject(new Error("no such window"));
          winMap.delete(id);
          tags.delete(id);
          for (const [tid, t] of [...tabMap]) if (t.windowId === id) tabMap.delete(tid);
          removed.windows.push(id);
          listeners.windowsRemoved.forEach((fn) => fn(id));
          return Promise.resolve();
        },
        onCreated: { addListener: (fn) => listeners.windowsCreated.push(fn) },
        onRemoved: { addListener: (fn) => listeners.windowsRemoved.push(fn) },
      },
      ...(sessionsApi ? {
        sessions: {
          setWindowValue: (id, key, value) => { sessionsCalls.push({ fn: "set", id, key, value }); if (key === TAG) tags.set(id, value); return Promise.resolve(); },
          getWindowValue: (id, key) => { sessionsCalls.push({ fn: "get", id, key }); return Promise.resolve(key === TAG ? tags.get(id) : undefined); },
        },
      } : {}),
      tabs: {
        create: (opts) => {
          const id = nextTab++;
          // the audit: a tab without an explicit window, or in a window that is the user's, is the bug
          if (opts.windowId == null) violations.push(`tabs.create without windowId: ${opts.url}`);
          else if (userWindowIds.has(opts.windowId)) violations.push(`tabs.create in the user's window ${opts.windowId}: ${opts.url}`);
          tabMap.set(id, { id, windowId: opts.windowId != null ? opts.windowId : 1, url: opts.url, pinned: !!opts.pinned, active: false, muted: false, status: "complete" });
          created.tabs.push({ id, url: opts.url, windowId: opts.windowId });
          events.push(`tab:${opts.windowId}:${opts.url}`);
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
  const flush = (ms = 80) => sleep(ms);
  return {
    ctx, storageLocal, storageSession, winMap, tags, tabMap, created, removed, events, listeners, violations, userWindowIds, sessionsCalls, flush,
    failNextCreates: (n) => { createFailuresLeft = n; },
    boot: async () => { vm.runInContext(bgSrc(), ctx); await flush(150); },
    tick: async () => { await vm.runInContext("serialized(autoWatchTick)", ctx); await flush(); },
    run: (src) => vm.runInContext(src, ctx),
    tabsIn: (winId) => [...tabMap.values()].filter((t) => t.windowId === winId),
    // a window Firefox brings back (late) after the extension started
    restoreWindow: (id, { tagged, tabs: wtabs }) => {
      winMap.set(id, { id, type: "normal", focused: false });
      if (tagged) tags.set(id, true); else userWindowIds.add(id);
      for (const t of wtabs) tabMap.set(t.id, { active: false, muted: false, status: "complete", windowId: id, ...t });
      listeners.windowsCreated.forEach((fn) => fn({ id, type: "normal" }));
    },
    watchWindowId: () => storageLocal.watchWindowId,
  };
}

const youtubeTab = (id, windowId) => ({ id, windowId, url: "https://www.youtube.com/", pinned: false });
const ourStaleTabs = (windowId, base) => [
  { id: base, windowId, url: INV, pinned: true },
  { id: base + 1, windowId, url: "https://www.twitch.tv/somechannel", pinned: true },
  { id: base + 2, windowId, url: CAMP, pinned: true },
];
const WATCH_URL = "'https://www.twitch.tv/somechannel'";

// ---- Part 1 ---------------------------------------------------------------------------------------
async function testConcurrentSwitchOnMakesOneWindowAndEveryTabLandsInIt() {
  const w = makeWorld({
    session: { tdcSessionStarted: 1 }, // same browser session: no restore grace
    local: { enabled: false, watchList: [{ input: "warframe", slug: "warframe" }, { input: "poe2", slug: "path-of-exile-2" }, { input: "diablo 4", slug: "diablo-iv" }] },
    windows: [{ id: 1 }], // the user's window, no Twitch tabs
    tabs: [youtubeTab(1, 1)],
    createDelay: 40, // the window takes a moment: every concurrent job meets it half-made
  });
  await w.boot();
  w.storageLocal.enabled = true;
  // the enabled handler, the inventory upkeep, the scheduler and bare window lookups, all at once
  w.listeners.storage.forEach((fn) => fn({ enabled: { newValue: true, oldValue: false } }, "local"));
  await Promise.all([
    w.run("serialized(openInventoryIfMissing)"), w.run("serialized(autoWatchTick)"),
    w.run("getOrCreateWatchWindow()"), w.run("getOrCreateWatchWindow()"),
  ]);
  await w.flush(250);

  assert.deepStrictEqual(w.violations, [], "no tab in the user's window and none without a window: " + w.violations.join(" | "));
  assert.strictEqual(w.created.windows.length, 1, "exactly one window 2 is created");
  const win2 = w.created.windows[0];
  assert.strictEqual(w.watchWindowId(), win2);
  assert.strictEqual(w.tags.get(win2), true, "and it is tagged");
  assert.ok(w.created.tabs.length > 0 && w.created.tabs.every((t) => t.windowId === win2), "every tab the extension opened is in window 2: " + JSON.stringify(w.created.tabs));
  assert.deepStrictEqual(w.tabsIn(1).map((t) => t.url), ["https://www.youtube.com/"], "the user's window still has exactly its own tab");
  assert.strictEqual(w.tabsIn(win2).filter((t) => /drops\/inventory/.test(t.url)).length, 1, "one inventory tab");
  console.log("  OK  switch-on with concurrent jobs: one window 2 (tagged), every tab in it, the user's window untouched");
}

async function testAJobBeforeWindow2IsReadyWaitsAndNeverFallsBackToTheCurrentWindow() {
  const watchList = [{ input: "warframe", slug: "warframe" }];
  // (a) the window is slow: the jobs wait for it (nothing opens before it exists)
  const slow = makeWorld({ session: { tdcSessionStarted: 1 }, windows: [{ id: 1 }], tabs: [youtubeTab(1, 1)], createDelay: 60, local: { watchList, enabled: false } });
  await slow.boot();
  slow.storageLocal.enabled = true;
  await Promise.all([slow.run("serialized(openInventoryIfMissing)"), slow.run("serialized(autoWatchTick)")]);
  const iEnd = slow.events.findIndex((e) => e.startsWith("create-end"));
  const firstTab = slow.events.findIndex((e) => e.startsWith("tab:"));
  assert.ok(iEnd >= 0 && (firstTab === -1 || firstTab > iEnd), "no tab is opened before window 2 exists: " + slow.events.join(", "));
  assert.deepStrictEqual(slow.violations, []);

  // (b) the window cannot be made: nothing opens anywhere (0.6.18 fell back to the current window)
  const broken = makeWorld({ session: { tdcSessionStarted: 1 }, windows: [{ id: 1 }], tabs: [youtubeTab(1, 1)], createFailures: 2, local: { watchList, enabled: false } });
  await broken.boot();
  broken.storageLocal.enabled = true;
  await broken.run("serialized(openInventoryIfMissing)");
  await broken.tick();
  assert.deepStrictEqual(broken.created.tabs, [], "no tab was opened at all, in particular none in the user's window");
  assert.deepStrictEqual(broken.violations, [], broken.violations.join(" | "));
  assert.deepStrictEqual(broken.tabsIn(1).map((t) => t.url), ["https://www.youtube.com/"]);
  // the next tick works and lands in window 2
  await broken.tick();
  await broken.flush(100);
  assert.strictEqual(broken.created.windows.length, 1);
  assert.ok(broken.created.tabs.length > 0 && broken.created.tabs.every((t) => t.windowId === broken.created.windows[0]), "retried at the next tick: in window 2");
  assert.deepStrictEqual(broken.violations, []);
  console.log("  OK  tab jobs wait for window 2; when there is none they are skipped - never opened in the current window");
}

async function testUncleanShutdownRestoreAdoptsTheTaggedWindowOnly() {
  const w = makeWorld({
    session: {}, // Firefox restarted: new browser session, ids numbered afresh
    local: { watchWindowId: 2 }, // stale: the id now belongs to somebody else's window
    windows: [
      { id: 1 }, // the user's own window
      { id: 2 }, // a USER window that merely looks like a watch window: only pinned twitch tabs + the inventory, no tag
      { id: 3, tagged: true }, // the restored old window 2
    ],
    tabs: [
      youtubeTab(10, 1),
      ...ourStaleTabs(2, 20),
      { id: 30, windowId: 3, url: INV, pinned: true },
      { id: 31, windowId: 3, url: "https://www.twitch.tv/oldchannel", pinned: true },
      { id: 32, windowId: 3, url: "about:home", pinned: false },
    ],
  });
  await w.boot();
  await w.flush(300);

  assert.deepStrictEqual(w.created.windows, [], "no second watch window is created");
  assert.strictEqual(w.watchWindowId(), 3, "the TAGGED window was adopted");
  assert.deepStrictEqual(w.removed.windows, [], "no window closed");
  assert.deepStrictEqual(w.violations, [], w.violations.join(" | "));
  assert.strictEqual(w.tabsIn(2).length, 3, "the look-alike user window keeps all its tabs");
  assert.ok(w.tabMap.has(10), "the user's own tab is untouched");
  assert.ok(w.tabMap.has(30) && !w.tabMap.has(31) && !w.tabMap.has(32), "the adopted window keeps one inventory tab; its stale watch/blank tabs are closed");
  assert.ok(w.created.tabs.length > 0 && w.created.tabs.every((t) => t.windowId === 3), "new watch tabs are opened in the adopted window");
  console.log("  OK  restore after an unclean shutdown: the tagged window is adopted, the user's windows (look-alike included) are not touched");
}

async function testALateRestoredTaggedWindowIsAdoptedNotDuplicated() {
  const w = makeWorld({ session: {}, local: {}, windows: [{ id: 1 }], tabs: [youtubeTab(10, 1)] });
  await w.boot(); // Firefox is still restoring: nothing is created yet
  assert.deepStrictEqual(w.created.windows, [], "during the restore grace no new window is made");
  assert.deepStrictEqual(w.created.tabs, []);

  w.restoreWindow(5, { tagged: true, tabs: [{ id: 50, url: INV, pinned: true }, { id: 51, url: "https://www.twitch.tv/oldchannel", pinned: true }] });
  await w.flush(400);

  assert.deepStrictEqual(w.created.windows, [], "adopted, not duplicated: still no new window");
  assert.strictEqual(w.watchWindowId(), 5);
  assert.deepStrictEqual(w.violations, []);
  assert.ok(w.created.tabs.length > 0 && w.created.tabs.every((t) => t.windowId === 5), "the watch tabs went to the late window");
  assert.ok(w.tabMap.has(50) && !w.tabMap.has(51), "its stale watch tab was closed");
  assert.ok(w.tabMap.has(10), "the user's tab is untouched");

  // and when nothing is restored the grace ends and window 2 is created on its own
  const quiet = makeWorld({ session: {}, local: {}, windows: [{ id: 1 }], tabs: [youtubeTab(10, 1)] });
  await quiet.boot();
  await quiet.flush(450);
  assert.strictEqual(quiet.created.windows.length, 1, "no restore: window 2 appears once the grace is over");
  assert.deepStrictEqual(quiet.violations, []);
  console.log("  OK  a restored window that arrives late (onCreated) is adopted, not duplicated; with no restore window 2 is made after the grace");
}

async function testAnUntaggedWindowThatLooksLikeOursIsNeverAdoptedOrClosed() {
  const w = makeWorld({
    session: { tdcSessionStarted: 1 },
    local: { watchWindowId: 1 }, // even a remembered id that now points at it
    windows: [{ id: 1 }],
    tabs: ourStaleTabs(1, 20), // only pinned twitch.tv tabs + the inventory + a campaigns tab, NO tag
  });
  await w.boot();
  await w.tick();
  await w.tick();
  assert.deepStrictEqual(w.removed.windows, [], "never closed");
  assert.deepStrictEqual(w.removed.tabs, [], "none of its tabs closed");
  assert.notStrictEqual(w.watchWindowId(), 1, "never adopted (not even through a remembered id)");
  assert.strictEqual(w.created.windows.length, 1, "window 2 is a new, tagged window");
  assert.strictEqual(w.tags.get(w.created.windows[0]), true);
  assert.deepStrictEqual(w.violations, []);
  assert.strictEqual(w.tabsIn(1).length, 3);
  console.log("  OK  an untagged window with only pinned twitch tabs + inventory is the user's: never adopted, never closed");
}

async function testWindow2ClosedMidRunStartsOverWithoutTouchingTheUsersWindow() {
  const w = makeWorld({ session: { tdcSessionStarted: 1 }, windows: [{ id: 1 }], tabs: [youtubeTab(10, 1)], local: { enabled: false } });
  await w.boot();
  w.storageLocal.enabled = true;
  await w.run("applyEnabledState(true)");
  await w.flush(150);
  const first = w.created.windows[0];
  assert.ok(first && w.created.tabs.every((t) => t.windowId === first), "sanity: running in window 2");

  // the user closes window 2, and Firefox cannot make a new one just now
  await w.run(`browser.windows.remove(${first})`);
  await w.flush(60);
  assert.strictEqual(w.watchWindowId(), null, "forgotten");
  const before = w.created.tabs.length;
  w.failNextCreates(1);
  await w.tick();
  assert.strictEqual(w.created.tabs.length, before, "nothing is opened while there is no window 2");
  assert.deepStrictEqual(w.violations, [], "in particular nothing in the user's window: " + w.violations.join(" | "));
  assert.deepStrictEqual(w.tabsIn(1).map((t) => t.url), ["https://www.youtube.com/"]);

  // it works again at the next tick: starts over in a new, tagged window 2
  await w.tick();
  await w.flush(100);
  assert.strictEqual(w.created.windows.length, 2, "a new window 2 replaces the closed one");
  const second = w.created.windows[1];
  assert.strictEqual(w.watchWindowId(), second);
  assert.strictEqual(w.tags.get(second), true);
  assert.ok(w.created.tabs.length > before && w.created.tabs.slice(before).every((t) => t.windowId === second));
  assert.deepStrictEqual(w.violations, []);
  assert.deepStrictEqual(w.tabsIn(1).map((t) => t.url), ["https://www.youtube.com/"], "the user's window never got a tab");
  console.log("  OK  window 2 closed mid-run: forgotten, nothing opens in the user's window, a new tagged window 2 follows");
}

async function testUserWindowsAreRecordedAtSwitchOnIncludingLaterOnes() {
  const w = makeWorld({
    session: { tdcSessionStarted: 1 }, local: { enabled: false },
    windows: [{ id: 1 }, { id: 2 }, { id: 3, tagged: true }],
    tabs: [youtubeTab(10, 1), youtubeTab(11, 2), { id: 12, windowId: 3, url: INV, pinned: true }],
  });
  await w.boot();
  w.storageLocal.enabled = true;
  await w.run("applyEnabledState(true)");
  await w.flush(100);
  const users = () => [...w.run("userWindowIds")].sort();
  assert.deepStrictEqual(users(), [1, 2], "every window that exists at switch-on and carries no tag is the user's; the tagged one is not");
  // a window the user opens afterwards is theirs too
  w.restoreWindow(9, { tagged: false, tabs: [youtubeTab(90, 9)] });
  await w.flush(50);
  assert.ok(users().includes(9), "a window opened after switching on belongs to the user");
  assert.ok(!users().includes(w.watchWindowId()), "window 2 is not on the list");
  console.log("  OK  user windows are recorded at switch-on (tagged one excluded) and any later window is the user's");
}

async function testALeftoverTaggedWindowIsClosedOnlyWhenItHoldsOnlyOurTabs() {
  const w = makeWorld({ session: { tdcSessionStarted: 1 }, windows: [{ id: 1 }], tabs: [youtubeTab(10, 1)], local: { enabled: true } });
  await w.boot();
  await w.flush(150);
  const ours = w.watchWindowId();
  assert.ok(ours, "sanity: window 2 exists");

  // a second restored window with our tag and only our tabs: a leftover
  w.restoreWindow(7, { tagged: true, tabs: [{ id: 70, url: INV, pinned: true }, { id: 71, url: "https://www.twitch.tv/old", pinned: true }] });
  await w.flush(250);
  assert.ok(!w.winMap.has(7), "the leftover tagged window is closed");
  assert.strictEqual(w.watchWindowId(), ours, "and window 2 stays the same");

  // one with a tab of the user's inside: left alone
  w.restoreWindow(8, { tagged: true, tabs: [{ id: 80, url: INV, pinned: true }, youtubeTab(81, 8)] });
  await w.flush(250);
  assert.ok(w.winMap.has(8) && w.tabMap.has(81), "a window holding a tab that is not ours is never closed");
  assert.deepStrictEqual(w.violations, []);
  console.log("  OK  a second tagged window is a leftover - closed only if nothing but our own tabs is in it");
}

async function testTheTagSurvivesAnExtensionReloadAndAStaleIdIsNotTrusted() {
  // same browser session, the extension is reloaded: window 2 is still open and tagged -> found by its tag
  const reload = makeWorld({ session: {}, local: { watchWindowId: null }, windows: [{ id: 1 }, { id: 2, tagged: true }], tabs: [youtubeTab(10, 1), { id: 20, windowId: 2, url: INV, pinned: true }] });
  await reload.boot();
  await reload.flush(300);
  assert.deepStrictEqual(reload.created.windows, [], "found by its tag: no second window");
  assert.strictEqual(reload.watchWindowId(), 2);
  assert.ok(reload.tabMap.has(20), "its inventory tab is kept");

  // a remembered id that now points at an untagged (the user's) window is dropped
  const stale = makeWorld({ session: { tdcSessionStarted: 1 }, local: { watchWindowId: 1 }, windows: [{ id: 1 }], tabs: [youtubeTab(10, 1)] });
  await stale.boot();
  await stale.tick();
  assert.notStrictEqual(stale.watchWindowId(), 1);
  assert.deepStrictEqual(stale.violations, []);
  assert.deepStrictEqual(stale.tabsIn(1).map((t) => t.url), ["https://www.youtube.com/"]);

  // the same browser session keeps its own window and tabs
  const same = makeWorld({
    session: { tdcSessionStarted: 1 },
    local: { watchWindowId: 1, watchTabs: { warframe: 2 }, watchMeta: { warframe: { channel: "somechannel", tabId: 2, watchStartedAt: 1 } } },
    windows: [{ id: 1, tagged: true }, { id: 2 }],
    tabs: [{ id: 1, windowId: 1, url: INV, pinned: true }, { id: 2, windowId: 1, url: "https://www.twitch.tv/somechannel", pinned: true }, youtubeTab(4, 2)],
  });
  await same.boot();
  assert.strictEqual(same.storageLocal.watchTabs.warframe, 2, "same session: remembered tab ids are kept");
  assert.ok(same.tabMap.has(2));
  assert.deepStrictEqual(same.created.windows, []);
  console.log("  OK  the tag is found again after an extension reload; a stale remembered id is not trusted; a normal session keeps its state");
}

async function testWithoutSessionsApiNothingBreaksAndNothingTouchesTheUser() {
  const w = makeWorld({ session: { tdcSessionStarted: 1 }, sessionsApi: false, windows: [{ id: 1 }], tabs: [youtubeTab(10, 1)], local: { enabled: true } });
  await w.boot();
  await w.flush(150);
  assert.strictEqual(w.created.windows.length, 1, "a window 2 is still made (it just cannot be recognised after a restore)");
  assert.deepStrictEqual(w.violations, []);
  assert.deepStrictEqual(w.tabsIn(1).map((t) => t.url), ["https://www.youtube.com/"]);
  console.log("  OK  a Firefox without a working sessions API still never touches the user's window");
}

// what the README promises about the `sessions` permission: only the tag is read or written, only
// on a window the extension created, nothing else of the sessions API is used
async function testTheSessionsApiIsUsedOnlyForTheTag() {
  const w = makeWorld({ session: { tdcSessionStarted: 1 }, windows: [{ id: 1 }, { id: 2 }], tabs: [youtubeTab(10, 1), youtubeTab(11, 2)], local: { enabled: true } });
  await w.boot();
  await w.flush(250);
  w.restoreWindow(9, { tagged: false, tabs: [youtubeTab(90, 9)] }); // a window the user opens
  await w.flush(250);
  const created = new Set(w.created.windows);
  assert.ok(w.sessionsCalls.length > 0);
  assert.ok(w.sessionsCalls.every((c) => c.key === TAG), "only the single key dropClaimerWatch is ever read or written");
  const writes = w.sessionsCalls.filter((c) => c.fn === "set");
  assert.ok(writes.length >= 1 && writes.every((c) => created.has(c.id) && c.value === true), "tags are written only on a window the extension itself created: " + JSON.stringify(writes));
  assert.ok(!writes.some((c) => c.id === 1 || c.id === 2 || c.id === 9), "never on the user's windows");
  assert.ok(w.sessionsCalls.some((c) => c.fn === "get" && c.id === 1), "the user's windows are only asked whether the tag is there");

  // static: the code calls exactly these two members of the sessions API, and no history/restore API
  const code = read("background.js").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const members = [...new Set([...code.matchAll(/browser\.sessions\.(\w+)/g)].map((m) => m[1]))].sort();
  assert.deepStrictEqual(members, ["getWindowValue", "setWindowValue"], "no getRecentlyClosed, no restore, nothing else: " + members.join(","));
  for (const f of ["background.js", "content.js", "popup.js", "inject.js", "gql-bridge.js", "shared.js"]) {
    const src = read(f).replace(/\/\/.*$/gm, "");
    assert.ok(!/browser\.history|browser\.browsingData|getRecentlyClosed|sessions\.restore/.test(src), `${f}: no history / recently-closed / restore API`);
    if (f !== "background.js") assert.ok(!/browser\.sessions/.test(src), `${f}: does not touch the sessions API`);
  }
  const manifest = JSON.parse(read("manifest.json"));
  assert.ok(manifest.permissions.includes("sessions") && !manifest.permissions.includes("history") && !manifest.permissions.includes("browsingData"));
  console.log("  OK  sessions API: only the dropClaimerWatch tag, written only on the extension's own window, read (asked) elsewhere; no history/restore API");
}

(async () => {
  console.log("Running watch window / session tests (fake windows+tabs+sessions, no real browser, no network)...\n");
  try {
    await testConcurrentSwitchOnMakesOneWindowAndEveryTabLandsInIt();
    await testAJobBeforeWindow2IsReadyWaitsAndNeverFallsBackToTheCurrentWindow();
    await testUncleanShutdownRestoreAdoptsTheTaggedWindowOnly();
    await testALateRestoredTaggedWindowIsAdoptedNotDuplicated();
    await testAnUntaggedWindowThatLooksLikeOursIsNeverAdoptedOrClosed();
    await testWindow2ClosedMidRunStartsOverWithoutTouchingTheUsersWindow();
    await testUserWindowsAreRecordedAtSwitchOnIncludingLaterOnes();
    await testALeftoverTaggedWindowIsClosedOnlyWhenItHoldsOnlyOurTabs();
    await testTheTagSurvivesAnExtensionReloadAndAStaleIdIsNotTrusted();
    await testWithoutSessionsApiNothingBreaksAndNothingTouchesTheUser();
    await testTheSessionsApiIsUsedOnlyForTheTag();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
