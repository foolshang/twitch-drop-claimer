/**
 * review-a.test.js - the severe findings of the 0.6.24 code review (group A)
 *
 *  A1 fresh install: a missing `enabled` was "on" at startup and in the popup but "off" in every scheduler check
 *  A2 the claim tier was the wrapper around all tiers when only one tier had a button -> the first tier's name
 *  A3 a drop-notification toast's other buttons (close "X") were clicked and read as a successful claim
 *  A4 popup Save started every game entry from scratch -> its resolved slug/gameId/campaign were lost
 *  A5 a temporarily blocked slug counted as "done" -> everything "finished" -> auto-off
 *
 * Real background.js / content.js / popup.js.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { SEC, flush, read, makeClock, makeBackground, run } = require("./claim-harness");

const ROOT = path.join(__dirname, "..");
const readFile = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// ---- in-memory tabs world for the scheduler (as in pinned-slots.test.js) --------------------------------
function makeWorld(storage) {
  const storageData = { autoWatchEnabled: true, tabQuota: 2, openCampaigns: { fetchedAt: Date.now(), bySlug: {} }, ...storage };
  const listeners = [];
  const tabsById = new Map();
  let nextTabId = 1;
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
        onChanged: { addListener: () => {} },
      },
      runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, getManifest: () => ({ version: "0.0.0-test" }) },
      tabs: {
        create: (opts) => { const id = nextTabId++; tabsById.set(id, { url: opts.url }); return Promise.resolve({ id }); },
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
  const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
  return {
    ctx, storageData, listeners, wait,
    tabs: () => Object.keys(storageData.watchTabs || {}).sort(),
    async boot() {
      vm.runInContext(readFile("shared.js"), ctx);
      vm.runInContext(readFile("i18n.js"), ctx);
      vm.runInContext(readFile("background.js"), ctx);
      await wait(100);
    },
    async tick() { await vm.runInContext("serialized(autoWatchTick)", ctx); await wait(); },
  };
}

// ---------------------------------------------------------------------------------------------------- A1
async function testFreshInstallRunsTheScheduler() {
  // a brand-new profile: nothing in storage, not even `enabled`
  const w = makeWorld({ watchList: [{ input: "x", slug: "x" }], enabled: undefined });
  await w.boot();
  assert.strictEqual(w.storageData.enabled, true, "the default is written at startup / install");
  assert.deepStrictEqual(w.tabs(), ["x"], "and the scheduler runs: the game's tab is open");

  // every check reads a missing value as ON - not only after the write
  const v = makeWorld({ watchList: [{ input: "y", slug: "y" }], enabled: true });
  await v.boot();
  v.storageData.enabled = undefined;
  v.storageData.watchList = [{ input: "y", slug: "y" }, { input: "z", slug: "z" }];
  v.storageData.tabQuota = 3;
  await v.tick();
  assert.deepStrictEqual(v.tabs(), ["y", "z"], "autoWatchTick treats a missing enabled as on");
  const tabId = v.storageData.watchTabs.y;
  const res = await v.listeners[0]({ type: "isWatchTab" }, { tab: { id: tabId } });
  assert.strictEqual(res.isWatchTab, true, "so does the message router (isWatchTab)");
  // an explicit OFF still switches everything off
  v.storageData.enabled = false;
  const off = await v.listeners[0]({ type: "isWatchTab" }, { tab: { id: tabId } });
  assert.strictEqual(off.isWatchTab, false);
  console.log("  OK  A1: a fresh install writes enabled:true and the scheduler runs; a missing value reads as on everywhere");
}

// ---------------------------------------------------------------------------------------------------- A2/A3 (content.js on a jsdom page)
const ORIGIN = "https://www.twitch.tv";
async function openDomTab({ clock, bg, html, pathname = "/drops/inventory" }) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: `${ORIGIN}${pathname}` });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  const observers = [];
  const sent = [];
  const localSets = [];
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    Set, Map, Promise, URL, JSON, Math, Array, Object, Number, String, RegExp,
    Date: clock.FakeDate,
    window, document: window.document, location: window.location,
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} },
    setInterval: () => 1, clearInterval() {},
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (t) => clock.clearTimeout(t),
    browser: {
      storage: { local: { get: () => Promise.resolve({ enabled: true, gameIdMap: {} }), set: (o) => { localSets.push(o); return Promise.resolve(); } }, onChanged: { addListener() {} } },
      runtime: { sendMessage: (m) => { sent.push(m); return bg.send(m, 1); }, onMessage: { addListener() {} } },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext(read("content.js"), ctx);
  await flush();
  const clicked = [];
  window.document.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) clicked.push(b.getAttribute("data-test") || b.getAttribute("aria-label") || b.textContent.trim()); }, true);
  return { window, sent, localSets, clicked, clock, scan: () => Promise.resolve(observers[0].cb([])), asks: () => sent.filter((m) => m.type === "claimAsk").map((m) => m.key) };
}

const tierHtml = (name, { button = false, percent = 100 } = {}) => `
  <div class="tier">
    <div><div><div><img alt="Reward Image Icon" src="https://static-cdn.jtvnw.net/x.png"></div><div><div><p>${name}</p></div></div></div></div>
    <div><div role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"></div><div><p><span>${percent}</span>% of 1 hour</p></div>
      ${button ? `<button data-test="${name}">Claim Now</button>` : ""}</div>
  </div>`;
const cardHtml = (tiers) => `<div class="card">
  <div><p title=""><a href="/drops/campaigns?dropID=camp-1">Some Campaign</a></p></div>
  <div><img data-test-selector="DropsCampaignInProgressDescription-game-card-image" alt="Drops Campaign Image" src="https://static-cdn.jtvnw.net/ttv-boxart/263490_IGDB-285x380.jpg"></div>
  <div>${tiers.join("")}</div></div><h5>Claimed</h5><div class="claimed"></div>`;

async function testTheClaimTierIsTheButtonsOwnTierNotTheWrapperOfAll() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  // tier 1 and 2 are already claimed (no button), tier 3 is claimable
  const tab = await openDomTab({ clock, bg, html: cardHtml([tierHtml("First reward"), tierHtml("Second reward"), tierHtml("Third reward", { button: true })]) });
  tab.window.document.querySelector('button[data-test="Third reward"]').addEventListener("click", (e) => e.target.remove());
  await tab.scan(); await flush();
  await run([tab], 25 * SEC);
  assert.deepStrictEqual(tab.asks(), ["camp-1:Third reward"], "the key carries the reward of the tier the button is in: " + JSON.stringify(tab.asks()));
  assert.deepStrictEqual(tab.localSets.filter((o) => o.lastClaimText).map((o) => o.lastClaimText), ["Third reward"], "Last claimed too");
  console.log("  OK  A2: a lone claimable tier among tiers without a button is named by its own tier");
}

async function testOnlyAClaimButtonOfAToastIsClicked() {
  const toastWithClose = `<div data-test-selector="drops-notification"><button aria-label="Close" data-test="close">X</button></div>`;
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const tab = await openDomTab({ clock, bg, html: toastWithClose, pathname: "/somechannel" });
  tab.window.document.querySelector('button[data-test="close"]').addEventListener("click", (e) => e.target.remove()); // the toast closes
  await tab.scan(); await flush();
  await run([tab], 25 * SEC);
  assert.deepStrictEqual(tab.clicked, [], "the close button of a drop toast is not clicked: " + JSON.stringify(tab.clicked));
  assert.ok(!tab.sent.some((m) => m.type === "claimResult" || m.type === "dropClaimed"), "no fake success");
  assert.ok(!tab.localSets.some((o) => o.lastClaimAt), "no fake last claim");

  // both in one toast: only the claim button
  const clock2 = makeClock();
  const bg2 = await makeBackground({ clock: clock2 });
  const tab2 = await openDomTab({ clock: clock2, bg: bg2, html: `<div data-test-selector="drops-notification"><button data-test="close" aria-label="Close">X</button><button data-test="claim">Claim Now</button></div>`, pathname: "/somechannel" });
  await tab2.scan(); await flush();
  assert.deepStrictEqual(tab2.clicked, ["claim"], "the claim button only");
  // the definite selector still needs no text (a language the list does not know)
  const clock3 = makeClock();
  const bg3 = await makeBackground({ clock: clock3 });
  const tab3 = await openDomTab({ clock: clock3, bg: bg3, html: `<div><button data-a-target="drops-claim-button" data-test="def">Réclamer</button></div>`, pathname: "/somechannel" });
  await tab3.scan(); await flush();
  assert.deepStrictEqual(tab3.clicked, ["def"], "drops-claim-button is a claim button by definition");
  console.log("  OK  A3: a toast's close button is never clicked; the claim button and drops-claim-button are");
}

// ---------------------------------------------------------------------------------------------------- A4 popup Save
async function openPopup(storage) {
  const dom = new JSDOM(readFile("popup.html").replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, ""), { runScripts: "outside-only", url: "moz-extension://test/popup.html" });
  const w = dom.window;
  const data = { enabled: true, autoWatchEnabled: true, ...storage };
  const pick = (keys) => {
    if (keys == null) return { ...data };
    if (typeof keys === "string") return { [keys]: data[keys] };
    const out = {};
    for (const k of keys) out[k] = data[k];
    return out;
  };
  w.browser = {
    storage: { local: { get: (k) => Promise.resolve(pick(k)), set: (o) => { Object.assign(data, o); return Promise.resolve(); } }, session: { get: () => Promise.resolve({}) }, onChanged: { addListener() {} } },
    runtime: { sendMessage: () => Promise.resolve({}), getManifest: () => ({ version: "0.0.0-test" }) },
    tabs: { query: () => Promise.resolve([]), create() {} },
  };
  Object.defineProperty(w.navigator, "language", { value: "en-US" });
  w.eval([readFile("i18n.js"), readFile("shared.js"), readFile("popup.js")].join("\n"));
  await new Promise((r) => setTimeout(r, 80));
  return { w, data };
}

async function testPopupSaveKeepsWhatWasResolvedForUnchangedEntries() {
  const resolved = { input: "rainbow six", slug: "tom-clancys-rainbow-six-siege", displayName: "Rainbow Six Siege", gameId: "4321", campaign: { open: true, endAt: 123, accountConnected: true, checkedAt: 5 } };
  const pinned = { input: "@streamer", slug: "channel:streamer", channel: "streamer", pinnedChannel: true, gameSlug: "rust", pinnedGameName: "Rust" };
  const { w, data } = await openPopup({ watchList: [resolved, pinned], watchListRaw: "rainbow six\n@streamer", gameWaitUntil: { "tom-clancys-rainbow-six-siege": Date.now() + 86_400_000 } });
  // the popup shows the resolved display name (reconcileGamesTextarea): that line is the same entry
  assert.ok(/Rainbow Six Siege/.test(w.document.getElementById("gamesList").value), "sanity: the textarea shows the display name");
  w.document.getElementById("save").click();
  await new Promise((r) => setTimeout(r, 60));
  const saved = data.watchList;
  assert.strictEqual(saved.length, 2);
  assert.strictEqual(saved[0].slug, "tom-clancys-rainbow-six-siege", "the resolved slug is kept (not toSlug of the display name): " + JSON.stringify(saved[0]));
  assert.strictEqual(saved[0].gameId, "4321");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved[0].campaign)), resolved.campaign, "and the campaign annotation");
  assert.strictEqual(saved[0].displayName, "Rainbow Six Siege");
  assert.deepStrictEqual([saved[1].gameSlug, saved[1].pinnedGameName], ["rust", "Rust"], "pinned entries keep the game they were seen playing");

  // a line the user changed or added starts from scratch
  w.document.getElementById("gamesList").value = "Rainbow Six Siege\n@streamer\nBrand New Game";
  w.document.getElementById("save").click();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(data.watchList.map((g) => g.slug))), ["tom-clancys-rainbow-six-siege", "channel:streamer", "brand-new-game"]);
  assert.ok(!data.watchList[2].gameId, "a new line has nothing resolved");
  console.log("  OK  A4: Save keeps the resolved slug/gameId/campaign of unchanged entries; new lines start fresh");
}

// ---------------------------------------------------------------------------------------------------- A5
async function testATemporaryBlockIsWaitingNotDone() {
  const w = makeWorld({
    enabled: true, autoOffEnabled: true, enabledSince: Date.now() - 3_600_000,
    watchList: [{ input: "x", slug: "x" }],
    invalidSlugs: { x: Date.now() + 3_600_000 }, // Twitch did not know the slug: blocked for an hour
  });
  await w.boot();
  await w.tick();
  assert.notStrictEqual(w.storageData.watchPhase, "all-done", "a blocked game is not 'everything finished': " + w.storageData.watchPhase);
  assert.strictEqual(w.storageData.enabled, true, "so auto-off does not switch the extension off for good");
  assert.deepStrictEqual(w.tabs(), [], "no tab for the blocked game meanwhile");
  console.log("  OK  A5: a temporarily blocked slug is waiting, not done (no all-done, no auto-off)");

  // a genuinely finished game next to a blocked one: still not done while the other waits
  const v = makeWorld({
    enabled: true, autoOffEnabled: true, enabledSince: Date.now() - 3_600_000,
    watchList: [{ input: "x", slug: "x" }, { input: "y", slug: "y" }],
    invalidSlugs: { x: Date.now() + 3_600_000 },
    campaignProgress: { y: { allComplete: true, expired: false, claimed: 1, total: 1 } },
  });
  await v.boot();
  await v.tick();
  assert.strictEqual(v.storageData.enabled, true);
  // and once the block has passed and the game is the only one left it is eligible again
  v.storageData.invalidSlugs = { x: Date.now() - 1000 };
  await v.tick();
  assert.ok(v.tabs().includes("x"), "after the block it is watched");
}

(async () => {
  console.log("Running review group A tests...\n");
  try {
    await testFreshInstallRunsTheScheduler();
    await testTheClaimTierIsTheButtonsOwnTierNotTheWrapperOfAll();
    await testOnlyAClaimButtonOfAToastIsClicked();
    await testPopupSaveKeepsWhatWasResolvedForUnchangedEntries();
    await testATemporaryBlockIsWaitingNotDone();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
