/**
 * pinned-live-wait.test.js
 *
 * A pinned "@channel" entry whose channel is offline used to just sit there
 * (a former transient-flash-at-creation, no reload trigger). A first fix put
 * a reload timer directly in content.js (setInterval + location.reload()) -
 * but a tab Firefox discards to free memory has NO content script left
 * running at all, so that timer could silently stop firing forever and the
 * channel would never be watched again, exactly the original bug. That fix
 * was replaced: content.js now ONLY reports what the DOM shows every 60s tick
 * (`pinnedChannelStatus`: live true/false/null, plus a sidebar-live hint when
 * offline) and NEVER calls location.reload() itself; the decision AND the
 * actual browser.tabs.reload() live in background.js instead, which persists
 * independently of any one tab's content script - handlePinnedChannelStatus()
 * reacts to each report, and sweepStalePinnedHeartbeats() (run every minute
 * off the existing AUTO_WATCH_ALARM cadence) force-reloads a tab that stops
 * reporting ENTIRELY, recovering even a fully discarded tab.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// markup from the live captures used elsewhere in this test suite
const LIVE = `
  <div class="channel-root channel-root--live"><div class="channel-root__info">
    <span data-a-target="animated-channel-viewers-count">7</span>
    <a data-a-target="stream-game-link" href="/directory/category/warframe"><span>Warframe</span></a>
  </div></div>`;
const OFFLINE = `
  <div class="channel-root"><div class="channel-root__player channel-root__player--offline"></div>
  <div class="channel-root__info channel-root__info--offline"></div></div>`;
const LOADING = `<div class="channel-root"></div>`;
const CONTENT_GATE = `<div class="channel-root"><div data-a-target="player-overlay-content-gate">Subscribers only</div></div>`;

const sidebarEntry = (name, live) =>
  `<div class="side-nav-card"><a data-a-id="followed-channel-0" data-test-selector="followed-channel" ` +
  `class="ScCoreLink side-nav-card__link tw-link${live ? "" : " side-nav-card__link--empty-category side-nav-card__link--offline"}" ` +
  `href="/${name}"><span>${name}</span><span>${live ? "Live 56 viewers" : "Offline"}</span></a></div>`;

// ---- content.js side -----------------------------------------------------
async function makeContent(initialHtml, { pinned = true, sidebar = "" } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><nav class="side-nav">${sidebar}</nav>${initialHtml}</body></html>`);
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; },
    configurable: true,
  });
  const intervals = [];
  const sent = [];
  let reloadCalls = 0;
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    document: window.document,
    location: {
      pathname: "/somestreamer", href: "https://www.twitch.tv/somestreamer", search: "",
      reload: () => { reloadCalls++; }, // must NEVER be called any more - asserted below
    },
    MutationObserver: window.MutationObserver,
    MouseEvent: window.MouseEvent, URL: globalThis.URL,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    setTimeout: (fn, ms) => { if (ms === 10_000) setImmediate(fn); return 0; }, // let the non-pinned 10s re-check fire
    clearTimeout: () => {},
    browser: {
      storage: {
        local: { get: () => Promise.resolve({ enabled: true }), set: () => Promise.resolve() },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: (msg) => {
          sent.push(msg);
          if (msg.type === "isWatchTab") {
            return Promise.resolve({
              isWatchTab: true,
              activeGame: { slug: "channel:somestreamer", pinnedChannel: pinned },
            });
          }
          return Promise.resolve();
        },
      },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("content.js"), ctx);
  await new Promise((r) => setImmediate(r)); // let storage.get().then(start) run
  const tick = intervals.find((i) => i.ms === 60_000);
  assert.ok(tick, "channel-page 60s monitor must be registered");
  return {
    tick: () => tick.fn(),
    setPage: (html) => { window.document.body.innerHTML = `<nav class="side-nav">${sidebar}</nav>${html}`; },
    sent, get reloadCalls() { return reloadCalls; },
  };
}

const statusMsgs = (c) => c.sent.filter((m) => m.type === "pinnedChannelStatus");

async function testLiveSendsStatusTrueEveryTick() {
  const c = await makeContent(LIVE);
  await c.tick(); await c.tick();
  assert.deepStrictEqual(statusMsgs(c).map((m) => m.live), [true, true]);
  assert.strictEqual(statusMsgs(c)[0].channel, "somestreamer");
  assert.strictEqual(c.reloadCalls, 0, "content.js never calls location.reload() itself any more");
  console.log("  OK  pinned + live: reports {live:true} every tick, never reloads itself");
}

async function testOfflineSendsStatusFalseWithSidebarHint() {
  const c = await makeContent(OFFLINE, { sidebar: sidebarEntry("somestreamer", false) });
  await c.tick(); await c.tick(); await c.tick(); await c.tick();
  const msgs = statusMsgs(c);
  assert.strictEqual(msgs.length, 4);
  for (const m of msgs) { assert.strictEqual(m.live, false); assert.strictEqual(m.sidebarLive, false); }
  assert.strictEqual(c.reloadCalls, 0, "even after many offline ticks, content.js still never reloads itself - that decision is background.js's now");
  console.log("  OK  pinned + offline: reports {live:false, sidebarLive:false} every tick indefinitely, no local reload");
}

async function testSidebarLiveIsReportedAsAHint() {
  const c = await makeContent(OFFLINE, { sidebar: sidebarEntry("SomeStreamer", true) }); // case-insensitive href match
  await c.tick();
  const m = statusMsgs(c)[0];
  assert.strictEqual(m.type, "pinnedChannelStatus");
  assert.strictEqual(m.channel, "somestreamer");
  assert.strictEqual(m.live, false);
  assert.strictEqual(m.sidebarLive, true);
  console.log("  OK  sidebar lists the channel live while the page says offline -> reported as a hint (case-insensitive), content.js still does not act on it");
}

async function testLoadingAndContentGateReportLiveNull() {
  for (const html of [LOADING, CONTENT_GATE]) {
    const c = await makeContent(html);
    await c.tick(); await c.tick();
    assert.deepStrictEqual(statusMsgs(c).map((m) => m.live), [null, null]);
    assert.strictEqual(c.reloadCalls, 0);
  }
  console.log("  OK  a loading page / subscriber-only gate reports {live:null} (still a heartbeat, not offline)");
}

async function testNonPinnedTabNeverSendsStatus() {
  const c = await makeContent(OFFLINE, { pinned: false });
  for (let i = 0; i < 5; i++) await c.tick();
  assert.strictEqual(statusMsgs(c).length, 0, "an ordinary (non-pinned) game tab never sends pinnedChannelStatus");
  assert.strictEqual(c.reloadCalls, 0);
  console.log("  OK  non-pinned watch tabs never send pinnedChannelStatus (old rotate-away behaviour unaffected)");
}

// ---- background.js side --------------------------------------------------
function makeBg({ enabled = true, watchList, tabWindow = 77 } = {}) {
  const storageData = {
    enabled, watchWindowId: 77,
    watchTabs: { "channel:somestreamer": 5, warframe: 6 },
    watchList: watchList || [
      { input: "@somestreamer", slug: "channel:somestreamer", channel: "somestreamer", pinnedChannel: true },
      { input: "warframe", slug: "warframe" },
    ],
  };
  const activeCalls = [];
  const reloadCalls = [];
  // vm.createContext gives background.js its OWN Date built-in, separate
  // from this file's - overriding the host Date.now has no effect on code
  // running inside the sandbox, so a controllable Date is passed in instead
  // (only `now()` is faked; everything else - `new Date()`, `Date.parse` -
  // still behaves normally) to fast-forward time without a real wait.
  let clockOffsetMs = 0;
  const RealDate = Date;
  class FakeDate extends RealDate {
    static now() { return RealDate.now() + clockOffsetMs; }
  }
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, URL: globalThis.URL, Blob: globalThis.Blob, Date: FakeDate,
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
      runtime: { onMessage: { addListener: () => {} }, getManifest: () => ({ version: "0.0.0-test" }) },
      windows: { get: (id) => Promise.resolve({ id }), create: () => Promise.reject(new Error("no")) },
      sessions: { getWindowValue: () => Promise.resolve(true), setWindowValue: () => Promise.resolve() }, // the watch window carries its tag
      tabs: {
        get: (id) => Promise.resolve({ id, windowId: tabWindow }),
        update: (id, opts) => { if ("active" in opts) activeCalls.push({ id, active: opts.active }); return Promise.resolve(); },
        reload: (id) => { reloadCalls.push(id); return Promise.resolve(); },
        create: () => Promise.resolve({ id: 1 }),
        query: () => Promise.resolve([]),
      },
      alarms: { create: () => {}, clear: () => Promise.resolve(true), onAlarm: { addListener: () => {} } },
      browserAction: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
      downloads: { download: () => Promise.resolve(1), search: () => Promise.resolve([]) },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext(read("background.js"), ctx);
  return {
    ctx, activeCalls, reloadCalls,
    status: vm.runInContext("handlePinnedChannelStatus", ctx),
    sweep: vm.runInContext("sweepStalePinnedHeartbeats", ctx),
    advanceClock: (ms) => { clockOffsetMs += ms; },
  };
}

const trueCalls = (b) => b.activeCalls.filter((c) => c.active === true);

async function testLiveFlashesTheTabOncePerTwoMinutes() {
  const b = makeBg();
  await b.status({ channel: "somestreamer", live: true }, { id: 5 });
  assert.deepStrictEqual(trueCalls(b), [{ id: 5, active: true }]);
  await b.status({ channel: "somestreamer", live: true }, { id: 5 });
  assert.strictEqual(trueCalls(b).length, 1, "a second live report within 2 min does not flash again");
  console.log("  OK  live report flashes the tab to start playback, once per 2 min");
}

async function testThreeOfflineTicksTriggerOneReload() {
  const b = makeBg();
  await b.status({ channel: "somestreamer", live: false, sidebarLive: false }, { id: 5 });
  await b.status({ channel: "somestreamer", live: false, sidebarLive: false }, { id: 5 });
  assert.deepStrictEqual(b.reloadCalls, [], "no reload before the 3rd offline report");
  await b.status({ channel: "somestreamer", live: false, sidebarLive: false }, { id: 5 });
  assert.deepStrictEqual(b.reloadCalls, [5], "3rd offline report reloads the tab");
  console.log("  OK  background.js reloads the pinned tab on the 3rd offline status report");
}

async function testSidebarHintReloadsImmediatelyAndIsRateLimited() {
  const b = makeBg();
  await b.status({ channel: "somestreamer", live: false, sidebarLive: true }, { id: 5 });
  assert.deepStrictEqual(b.reloadCalls, [5], "sidebar-live hint reloads on the very first offline report");
  await b.status({ channel: "somestreamer", live: false, sidebarLive: true }, { id: 5 });
  assert.deepStrictEqual(b.reloadCalls, [5], "a second sidebar-triggered reload within 2 min is suppressed (rate limit)");
  console.log("  OK  a sidebar-live hint reloads immediately, rate-limited to one per 2 min");
}

async function testLiveResetsTheOfflineCounter() {
  const b = makeBg();
  await b.status({ channel: "somestreamer", live: false }, { id: 5 });
  await b.status({ channel: "somestreamer", live: false }, { id: 5 });
  await b.status({ channel: "somestreamer", live: true }, { id: 5 }); // stream came back before tick 3
  await b.status({ channel: "somestreamer", live: false }, { id: 5 });
  await b.status({ channel: "somestreamer", live: false }, { id: 5 });
  assert.deepStrictEqual(b.reloadCalls, [], "counter was reset by the live report - only 2 offline reports since");
  console.log("  OK  a live report in between resets the offline-tick counter (no premature reload)");
}

async function testLoadingNullNeitherFlashesNorReloads() {
  const b = makeBg();
  for (let i = 0; i < 5; i++) await b.status({ channel: "somestreamer", live: null }, { id: 5 });
  assert.deepStrictEqual(trueCalls(b), []);
  assert.deepStrictEqual(b.reloadCalls, []);
  console.log("  OK  {live:null} (loading/gated) neither flashes nor reloads, however many times reported");
}

async function testStatusIgnoresEverythingElse() {
  const ordinary = makeBg();
  await ordinary.status({ channel: "x", live: false }, { id: 6 }); // tab 6 is the ordinary game entry
  await ordinary.status({ channel: "x", live: false }, { id: 6 });
  await ordinary.status({ channel: "x", live: false }, { id: 6 });
  assert.deepStrictEqual(ordinary.reloadCalls, [], "an ordinary game tab is never reloaded by pinnedChannelStatus");

  const unknown = makeBg();
  await unknown.status({ channel: "x", live: false }, { id: 999 });
  assert.deepStrictEqual(unknown.reloadCalls, [], "an untracked tab (the user's own) is never touched");

  const off = makeBg({ enabled: false });
  await off.status({ channel: "somestreamer", live: true }, { id: 5 });
  assert.deepStrictEqual(off.activeCalls, [], "nothing happens while the extension is switched off");

  const noTab = makeBg();
  await noTab.status({ channel: "somestreamer", live: true }, undefined);
  assert.deepStrictEqual(noTab.activeCalls, []);
  console.log("  OK  background ignores ordinary tabs, untracked tabs, and OFF state");
}

async function testHeartbeatSafetyNetRecoversADeadTab() {
  const b = makeBg();
  await b.status({ channel: "somestreamer", live: false }, { id: 5 }); // one report, then the tab "dies" (discarded)
  await b.sweep();
  assert.deepStrictEqual(b.reloadCalls, [], "not yet stale");

  b.advanceClock(6 * 60 * 1000); // 6 min of total silence
  await b.sweep();
  assert.deepStrictEqual(b.reloadCalls, [5], "no report at all for 6 min -> the safety net reloads the tab itself");
  console.log("  OK  sweepStalePinnedHeartbeats reloads a pinned tab that stopped reporting entirely (simulated tab discard)");
}

async function testHeartbeatSafetyNetGivesFreshTabsAGracePeriod() {
  const b = makeBg(); // no status report has ever arrived for this tab yet
  await b.sweep();
  assert.deepStrictEqual(b.reloadCalls, [], "a freshly opened tab is not reloaded before it has had a chance to report in");
  console.log("  OK  a tab with no report yet gets a grace period, not an immediate reload");
}

async function testHeartbeatSafetyNetLeavesRecentlyReportingTabsAlone() {
  const b = makeBg();
  await b.status({ channel: "somestreamer", live: true }, { id: 5 });
  await b.sweep();
  assert.deepStrictEqual(b.reloadCalls, [], "a tab that just reported in is left alone");
  console.log("  OK  a tab that recently reported in is never touched by the safety net");
}

(async () => {
  console.log("Running pinned-channel live-wait tests (no real browser, no network)...\n");
  try {
    await testLiveSendsStatusTrueEveryTick();
    await testOfflineSendsStatusFalseWithSidebarHint();
    await testSidebarLiveIsReportedAsAHint();
    await testLoadingAndContentGateReportLiveNull();
    await testNonPinnedTabNeverSendsStatus();
    await testLiveFlashesTheTabOncePerTwoMinutes();
    await testThreeOfflineTicksTriggerOneReload();
    await testSidebarHintReloadsImmediatelyAndIsRateLimited();
    await testLiveResetsTheOfflineCounter();
    await testLoadingNullNeitherFlashesNorReloads();
    await testStatusIgnoresEverythingElse();
    await testHeartbeatSafetyNetRecoversADeadTab();
    await testHeartbeatSafetyNetGivesFreshTabsAGracePeriod();
    await testHeartbeatSafetyNetLeavesRecentlyReportingTabsAlone();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
