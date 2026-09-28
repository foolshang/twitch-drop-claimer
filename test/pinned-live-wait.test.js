/**
 * pinned-live-wait.test.js
 *
 * A pinned "@channel" entry whose channel is offline used to just sit there:
 * content.js's pinned branch only reported the game once the page happened to
 * show live, nothing reloaded an offline page, and the one playback "flash"
 * (flashTabToStartPlayback) happened at tab creation, when there was no
 * stream to start. So a channel that went live later never got watched.
 *
 * Now, while the page shows explicit offline markers, content.js reloads it
 * every PINNED_OFFLINE_RELOAD_TICKS (3) 60s ticks; the first time it sees the
 * channel live it sends "pinnedChannelLive"; background.js then flashes that
 * tab (watch window only, not twice within 2 min). If the user follows the
 * channel and their sidebar entry already shows it live while the page still
 * says offline, the reload happens on the next tick instead (rate-limited).
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// markup from the live captures used by channel-live-detection.test.js
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

function readContentJs() {
  return read("content.js");
}

// followed-channel sidebar entries, markup captured live 2026-09-28: an
// offline one carries side-nav-card__link--offline (text "Offline")
const sidebarEntry = (name, live) =>
  `<div class="side-nav-card"><a data-a-id="followed-channel-0" data-test-selector="followed-channel" ` +
  `class="ScCoreLink side-nav-card__link tw-link${live ? "" : " side-nav-card__link--empty-category side-nav-card__link--offline"}" ` +
  `href="/${name}"><span>${name}</span><span>${live ? "Live 56 viewers" : "Offline"}</span></a></div>`;

// same channel in the sidebar's collapsed (avatar-only) mode: the anchor itself
// is `.side-nav-card`, an offline one has `.side-nav-card__avatar--offline`
const collapsedEntry = (name, live) =>
  `<a class="ScCoreLink side-nav-card tw-link" href="/${name}"><div class="side-nav-card__avatar${live ? "" : " side-nav-card__avatar--offline"}"><img></div></a>`;

// "Live Channels" (recommended) entry: only ever lists live channels
const recommendedEntry = (name) =>
  `<div class="side-nav-card"><a data-test-selector="recommended-channel" class="ScCoreLink side-nav-card__link tw-link" href="/${name}"><span>${name}</span><span>Live 11.9K viewers</span></a></div>`;

async function makeContent(initialHtml, { pinned = true, sidebar = "", session = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><nav class="side-nav">${sidebar}</nav>${initialHtml}</body></html>`);
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; },
    configurable: true,
  });
  const intervals = [];
  const sent = [];
  let reloads = 0;
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    document: window.document,
    location: {
      pathname: "/somestreamer", href: "https://www.twitch.tv/somestreamer", search: "",
      reload: () => { reloads++; },
    },
    MutationObserver: window.MutationObserver,
    MouseEvent: window.MouseEvent, URL: globalThis.URL,
    sessionStorage: {
      getItem: (k) => (k in session ? session[k] : null),
      setItem: (k, v) => { session[k] = String(v); },
    },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    // only the non-pinned path's 10s problem re-check is awaited; run it now
    setTimeout: (fn, ms) => { if (ms === 10_000) setImmediate(fn); return 0; },
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
  vm.runInContext(readContentJs(), ctx);
  await new Promise((r) => setImmediate(r)); // let storage.get().then(start) run
  const tick = intervals.find((i) => i.ms === 60_000);
  assert.ok(tick, "channel-page 60s monitor must be registered");
  return {
    tick: () => tick.fn(),
    setPage: (html) => { window.document.body.innerHTML = `<nav class="side-nav">${sidebar}</nav>${html}`; },
    sent, get reloads() { return reloads; },
  };
}

const liveMsgs = (c) => c.sent.filter((m) => m.type === "pinnedChannelLive");

async function testOfflineChannelIsReloadedEveryThirdTick() {
  const c = await makeContent(OFFLINE);
  await c.tick(); await c.tick();
  assert.strictEqual(c.reloads, 0, "no reload before 3 offline ticks");
  await c.tick();
  assert.strictEqual(c.reloads, 1, "third offline tick reloads the page");
  assert.strictEqual(liveMsgs(c).length, 0);
  console.log("  OK  pinned + offline markers: page reloaded on the 3rd 60s tick, not before");
}

async function testLoadingPageAndContentGateAreNeverReloaded() {
  for (const [label, html] of [["loading page", LOADING], ["content gate", CONTENT_GATE]]) {
    const c = await makeContent(html);
    for (let i = 0; i < 8; i++) await c.tick();
    assert.strictEqual(c.reloads, 0, `${label} has no explicit offline marker - must not be reloaded`);
  }
  console.log("  OK  a loading page / subscriber-only gate is not treated as offline (no reload loop)");
}

async function testLiveIsReportedOnceThenAgainAfterOffline() {
  const c = await makeContent(OFFLINE);
  await c.tick(); await c.tick();
  c.setPage(LIVE); // Twitch flipped the page (or a reload landed live)
  await c.tick();
  assert.strictEqual(liveMsgs(c).length, 1, "first live sighting reported");
  assert.strictEqual(liveMsgs(c)[0].channel, "somestreamer");
  assert.strictEqual(c.reloads, 0, "offline counter was reset by the live sighting, no stray reload");
  await c.tick(); await c.tick();
  assert.strictEqual(liveMsgs(c).length, 1, "not re-reported while it stays live");
  assert.ok(c.sent.some((m) => m.type === "channelPlayingGame" && m.slug === "warframe"), "game binding report still sent");

  // stream ends, and the page flips back to live before the 3rd offline tick:
  // the "seen live" flag was cleared, so the next live sighting is reported
  c.setPage(OFFLINE);
  await c.tick();
  c.setPage(LIVE);
  await c.tick();
  assert.strictEqual(liveMsgs(c).length, 2, "reported again for the next live session");
  assert.strictEqual(c.reloads, 0);

  // after an actual reload the old instance is gone and a fresh content
  // script starts from scratch - it reports its own first live sighting
  const fresh = await makeContent(OFFLINE);
  await fresh.tick();
  fresh.setPage(LIVE);
  await fresh.tick();
  assert.strictEqual(liveMsgs(fresh).length, 1, "a fresh page load reports its first live sighting");
  console.log("  OK  live reported once per session (again after an offline gap); offline counter resets on live");
}

async function testSidebarLiveTriggersImmediateReload() {
  // the user follows somestreamer; sidebar says live, the page still says offline
  const c = await makeContent(OFFLINE, { sidebar: sidebarEntry("SomeStreamer", true) }); // href case differs on purpose
  await c.tick();
  assert.strictEqual(c.reloads, 1, "reload on the very first tick, not the third");
  console.log("  OK  sidebar lists the pinned channel live while the page says offline -> reload now (case-insensitive href)");
}

async function testSidebarOfflineOrAbsentOrOthersLiveDoesNotTrigger() {
  const cases = [
    ["sidebar says offline", sidebarEntry("somestreamer", false)],
    ["channel not followed / absent", ""],
    ["only OTHER channels are live", sidebarEntry("someoneelse", true) + sidebarEntry("anotherperson", true)],
  ];
  for (const [label, sidebar] of cases) {
    const c = await makeContent(OFFLINE, { sidebar });
    await c.tick(); await c.tick();
    assert.strictEqual(c.reloads, 0, `${label}: no early reload`);
    await c.tick();
    assert.strictEqual(c.reloads, 1, `${label}: still reloads on the 3rd tick`);
  }
  console.log("  OK  offline sidebar entry / not followed / other channels' Live badges never trigger the early reload");
}

async function testCollapsedAndRecommendedSidebarModes() {
  const live = await makeContent(OFFLINE, { sidebar: collapsedEntry("somestreamer", true) });
  await live.tick();
  assert.strictEqual(live.reloads, 1, "collapsed sidebar, avatar not marked offline -> live -> early reload");

  const off = await makeContent(OFFLINE, { sidebar: collapsedEntry("somestreamer", false) });
  await off.tick(); await off.tick();
  assert.strictEqual(off.reloads, 0, "collapsed sidebar, avatar marked offline -> no early reload");

  const rec = await makeContent(OFFLINE, { sidebar: recommendedEntry("somestreamer") });
  await rec.tick();
  assert.strictEqual(rec.reloads, 1, "the channel listed under Live Channels is live too");

  const twice = await makeContent(OFFLINE, { sidebar: sidebarEntry("somestreamer", false) + recommendedEntry("somestreamer") });
  await twice.tick();
  assert.strictEqual(twice.reloads, 1, "any live entry for the channel wins over an offline duplicate");
  console.log("  OK  collapsed (avatar-only) sidebar and the Live Channels list work like the expanded Followed list");
}

async function testSidebarReloadIsRateLimited() {
  const session = {};
  const first = await makeContent(OFFLINE, { sidebar: sidebarEntry("somestreamer", true), session });
  await first.tick();
  assert.strictEqual(first.reloads, 1);
  assert.ok(session.tdc_pinned_sidebar_reload_at, "reload time remembered across the reload");

  // the reloaded page STILL says offline while the sidebar still says live
  const again = await makeContent(OFFLINE, { sidebar: sidebarEntry("somestreamer", true), session });
  await again.tick(); await again.tick();
  assert.strictEqual(again.reloads, 0, "no second sidebar-triggered reload within 2 min (no reload loop)");
  await again.tick();
  assert.strictEqual(again.reloads, 1, "the normal 3-tick reload still applies");

  session.tdc_pinned_sidebar_reload_at = String(Date.now() - 3 * 60 * 1000);
  const later = await makeContent(OFFLINE, { sidebar: sidebarEntry("somestreamer", true), session });
  await later.tick();
  assert.strictEqual(later.reloads, 1, "allowed again once 2 min have passed");
  console.log("  OK  sidebar-triggered reloads are limited to one per 2 min, remembered across reloads");
}

async function testNonPinnedTabIsUnchanged() {
  const c = await makeContent(OFFLINE, { pinned: false });
  for (let i = 0; i < 6; i++) await c.tick();
  assert.strictEqual(c.reloads, 0, "an ordinary game tab never reloads-and-waits");
  assert.strictEqual(liveMsgs(c).length, 0);
  console.log("  OK  non-pinned watch tabs keep their old behaviour (no reload, no live report)");
}

// ---- background.js -----------------------------------------------------
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
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, URL: globalThis.URL, Blob: globalThis.Blob,
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
      tabs: {
        get: (id) => Promise.resolve({ id, windowId: tabWindow }),
        update: (id, opts) => { if ("active" in opts) activeCalls.push({ id, active: opts.active }); return Promise.resolve(); },
        create: () => Promise.resolve({ id: 1 }),
        query: () => Promise.resolve([]),
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
  vm.runInContext(read("background.js"), ctx);
  return { ctx, activeCalls, handle: vm.runInContext("handlePinnedChannelLive", ctx) };
}

const trueCalls = (b) => b.activeCalls.filter((c) => c.active === true);

async function testBackgroundFlashesPinnedTabOnce() {
  const b = makeBg();
  await b.handle({ channel: "somestreamer" }, { id: 5 });
  assert.deepStrictEqual(trueCalls(b), [{ id: 5, active: true }], "pinned tab in the watch window is flashed");
  await b.handle({ channel: "somestreamer" }, { id: 5 });
  assert.strictEqual(trueCalls(b).length, 1, "a second report within 2 min does not flash again");
  console.log("  OK  background flashes a pinned tab when it reports live, once per 2 min");
}

async function testBackgroundIgnoresEverythingElse() {
  const ordinary = makeBg();
  await ordinary.handle({ channel: "x" }, { id: 6 }); // tab 6 = ordinary game entry
  assert.strictEqual(trueCalls(ordinary).length, 0, "an ordinary game tab is never flashed by this message");

  const unknown = makeBg();
  await unknown.handle({ channel: "x" }, { id: 999 });
  assert.strictEqual(trueCalls(unknown).length, 0, "an untracked tab (the user's own) is never touched");

  const elsewhere = makeBg({ tabWindow: 12 });
  await elsewhere.handle({ channel: "somestreamer" }, { id: 5 });
  assert.strictEqual(trueCalls(elsewhere).length, 0, "a tab outside the dedicated watch window is never flashed");

  const off = makeBg({ enabled: false });
  await off.handle({ channel: "somestreamer" }, { id: 5 });
  assert.strictEqual(trueCalls(off).length, 0, "nothing happens while the extension is switched off");

  const noTab = makeBg();
  await noTab.handle({ channel: "somestreamer" }, undefined);
  assert.strictEqual(trueCalls(noTab).length, 0);
  console.log("  OK  background ignores ordinary tabs, untracked tabs, other windows, and OFF state");
}

async function testBoundPinnedEntryStillCounts() {
  // after handleChannelPlayingGame the entry's slug is the real game slug but stays pinnedChannel
  const b = makeBg({
    watchList: [{ input: "@somestreamer", slug: "warframe", channel: "somestreamer", pinnedChannel: true }],
  });
  b.ctx; // storage watchTabs still maps tab 5 under the old key - rekey like the real binder does
  await vm.runInContext(`browser.storage.local.set({ watchTabs: { warframe: 5 } })`, b.ctx);
  await b.handle({ channel: "somestreamer" }, { id: 5 });
  assert.strictEqual(trueCalls(b).length, 1, "a pinned entry already bound to a real game slug is still flashed");
  console.log("  OK  a pinned entry bound to a real game slug is still recognised");
}

(async () => {
  console.log("Running pinned-channel live-wait tests (no real browser, no network)...\n");
  try {
    await testOfflineChannelIsReloadedEveryThirdTick();
    await testLoadingPageAndContentGateAreNeverReloaded();
    await testLiveIsReportedOnceThenAgainAfterOffline();
    await testSidebarLiveTriggersImmediateReload();
    await testSidebarOfflineOrAbsentOrOthersLiveDoesNotTrigger();
    await testCollapsedAndRecommendedSidebarModes();
    await testSidebarReloadIsRateLimited();
    await testNonPinnedTabIsUnchanged();
    await testBackgroundFlashesPinnedTabOnce();
    await testBackgroundIgnoresEverythingElse();
    await testBoundPinnedEntryStillCounts();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
