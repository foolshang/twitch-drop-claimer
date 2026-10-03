/**
 * review-c.test.js - the low-priority findings C1-C4, C6-C10 of the 0.6.24 code review
 *
 *  C1 replaying the last scan when the Inventory GQL arrives counted as another "missing" scan
 *  C2 maps that only grew: expired blocked channels, progress of removed entries, per-tab maps
 *  C3 a channel path rewritten to lower case looked like a raid
 *  C4 "@" lines / pasted URLs were not validated (broken URLs)
 *  C6 the 10 s problem re-check survived a quick off/on toggle
 *  C7 inject.js missed fetch(Request/URL) and XHR with responseType json/blob
 *  C8 the retroactive claim check read the Claimed list on every DOM mutation
 *  C9 a click with no request was paired with a later click's request; claimKeyBySeq never pruned
 *  C10 flashTabToStartPlayback relied on tabs.update({active:false}), which Firefox ignores (test in
 *      auto-watch-multi-tab.test.js: the previously active tab is activated again)
 *  (C5 "24:00" is in review-b-popup.test.js)
 */

const vm = require("vm");
const assert = require("assert");
const { SEC, flush, makeClock, makeBackground, run } = require("./claim-harness");
const { makeWorld, openDomTab, readFile } = require("./world-helpers");
const { realCard, parseCards, world, pinnedEntry, gqlCampaign, TAC } = require("./campaign-matching.test.js");

// ---------------------------------------------------------------------------------------------------- C1
async function testAReplayIsNotAnotherMissingScan() {
  const watchList = [pinnedEntry("itsryanhiga")];
  const w = await world({ watchList });
  const KEY = "channel:itsryanhiga";
  await w.gql([gqlCampaign(TAC)]);
  await w.scan(parseCards({ cards: [realCard({ campaign: TAC, percent: 50 })], watchList }));
  assert.ok(w.progress(KEY).total > 0);

  await w.gql([]); // the campaign left In Progress (everything claimed)
  await w.scan([], [[TAC.name, 1]]); // ONE real scan with the card missing
  assert.strictEqual(w.progress(KEY).allComplete, false, "one scan: not yet (REQUIRED_MISSING_SCANS is 2)");
  assert.strictEqual(w.progress(KEY).missingScans, 1);
  await w.gql([]); // a newer Inventory GQL arrives: the same scan is judged again - not a second one
  assert.strictEqual(w.progress(KEY).allComplete, false, "the replay is not another missing scan");
  assert.strictEqual(w.progress(KEY).missingScans, 1, "still 1: " + JSON.stringify(w.progress(KEY)));
  await w.scan([], [[TAC.name, 1]]); // the second real scan
  assert.strictEqual(w.progress(KEY).allComplete, true, "two real scans: done");
  console.log("  OK  C1: replaying the last scan for a new Inventory GQL does not count as another missing scan");
}

// ---------------------------------------------------------------------------------------------------- C2
async function testMapsStopGrowing() {
  const w = makeWorld({
    enabled: true, watchList: [{ input: "x", slug: "x" }],
    openCampaigns: { fetchedAt: Date.now(), bySlug: { x: { slug: "x", displayName: "x", active: true } } },
    blockedChannels: { x: { stale: Date.now() - 1000, fresh: Date.now() + 3_600_000 }, y: { gone: Date.now() - 5000 } },
  });
  await w.boot();
  await w.settledTick();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(w.storageData.blockedChannels)), { x: { fresh: w.storageData.blockedChannels.x.fresh } }, "expired blocks are removed, a live one stays");

  // an entry removed from the list takes its progress with it
  w.storageData.campaignProgress = { gone: { claimed: 1, total: 2 }, x: { claimed: 0, total: 1 } };
  w.storageData.watchList = [{ input: "x", slug: "x" }];
  await w.storageChanged({ watchList: { newValue: w.storageData.watchList } });
  assert.deepStrictEqual(Object.keys(w.storageData.campaignProgress), ["x"], "progress of a removed entry is pruned");

  // per-tab maps are emptied when the tab closes
  vm.runInContext("pinnedTabState.set(77, {}); lastPinnedReloadAt.set(77, 1); lastPlaybackFlashAt.set(77, 1); pinnedFlashedRun.set(77, 1)", w.ctx);
  for (const fn of w.removedListeners) fn(77);
  const left = vm.runInContext("[pinnedTabState, lastPinnedReloadAt, lastPlaybackFlashAt, pinnedFlashedRun].map((m) => m.has(77))", w.ctx);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(left)), [false, false, false, false], "no per-tab map keeps a closed tab");
  console.log("  OK  C2: expired blocks, removed entries' progress and closed tabs' map entries are pruned");
}

// ---------------------------------------------------------------------------------------------------- C3 / C6 (channel page monitor)
async function watchedChannelWorld({ pathname, html, pinned = false }) {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const slug = pinned ? "channel:geega" : "x";
  Object.assign(bg.local, {
    enabled: true, autoWatchEnabled: true,
    watchList: [pinned ? { input: "@geega", slug, channel: "geega", pinnedChannel: true } : { input: "x", slug: "x" }],
    watchTabs: { [slug]: 1 },
  });
  const tab = await openDomTab({ clock, bg, html, pathname });
  const monitor = () => tab.intervals.find((i) => !i.cleared && i.ms === 60_000 && /getWatchTabInfo/.test(String(i.fn)));
  return { clock, bg, tab, monitor };
}

async function testALowerCasedPathIsNotARaid() {
  const w = await watchedChannelWorld({ pathname: "/GEEGA", html: '<div data-a-target="animated-channel-viewers-count">1</div>', pinned: true });
  const m = w.monitor();
  assert.ok(m, "the channel monitor is running");
  w.tab.navigate("/geega"); // Twitch rewrites the path to lower case
  await m.fn();
  await flush();
  assert.ok(!w.tab.sent.some((x) => x.type === "channelRedirected"), "not reported as a redirect");
  assert.ok(w.monitor() === m, "and the monitor was not restarted for it");
  console.log("  OK  C3: a path rewritten to lower case is not a raid/redirect");
}

async function testTheProblemRecheckDoesNotSurviveAnOffOnToggle() {
  const w = await watchedChannelWorld({ pathname: "/somechannel", html: '<div class="channel-root__player--offline">offline</div>' });
  const m = w.monitor();
  assert.ok(m);
  const running = m.fn(); // sees "offline" and waits 10 s before acting
  await flush();
  w.tab.setEnabled(false); // a quick off ...
  w.tab.setEnabled(true); // ... and on again
  await flush();
  w.clock.advanceTo(w.clock.now + 11 * SEC);
  await running;
  await flush();
  assert.ok(!w.tab.sent.some((x) => x.type === "channelOffline"), "the old run's re-check did not act after the toggle: " + JSON.stringify(w.tab.sent.map((x) => x.type)));
  console.log("  OK  C6: a re-check started before a quick off/on toggle does not act afterwards");
}

// ---------------------------------------------------------------------------------------------------- C4
async function testWatchListLinesAreValidated() {
  const ctx = vm.createContext({ URL });
  vm.runInContext(readFile("shared.js"), ctx);
  const parse = (raw) => JSON.parse(vm.runInContext(`JSON.stringify(parseWatchList(${JSON.stringify(raw)}))`, ctx));
  const invalid = (raw) => JSON.parse(vm.runInContext(`JSON.stringify(invalidWatchLines(${JSON.stringify(raw)}))`, ctx));
  const chans = (raw) => parse(raw).filter((g) => g.pinnedChannel).map((g) => g.channel);

  assert.deepStrictEqual(chans("@streamer"), ["streamer"]);
  assert.deepStrictEqual(chans("@https://twitch.tv/x"), ["x"], "a pasted URL after @");
  assert.deepStrictEqual(chans("https://www.twitch.tv/Streamer"), ["Streamer"], "a channel URL without @ is a pinned channel, not a game");
  assert.deepStrictEqual(chans("twitch.tv/y_1"), ["y_1"], "also without a scheme");
  assert.strictEqual(parse("https://www.twitch.tv/Streamer")[0].input, "@Streamer");
  for (const bad of ["@@x", "@ a b", "@", "@https://example.com/x", "https://example.com/x", "https://twitch.tv/directory/category/rust", "@bad-name!", "@" + "a".repeat(30)]) {
    assert.deepStrictEqual(parse(bad), [], `${bad}: no broken entry`);
    assert.deepStrictEqual(invalid(bad), [bad], `${bad}: reported as invalid`);
  }
  assert.deepStrictEqual(invalid("Rust\n@good\n@@bad\nhttps://example.com/x"), ["@@bad", "https://example.com/x"]);
  // games and valid channels are as before
  assert.deepStrictEqual(parse("Rust\n@Name").map((g) => g.slug), ["rust", "channel:name"]);
  console.log("  OK  C4: '@' lines and twitch.tv URLs are validated; a URL becomes a pinned channel; invalid lines are reported");
}

// ---------------------------------------------------------------------------------------------------- C7
function injectWorld() {
  const posted = [];
  const GQL = "https://gql.twitch.tv/gql";
  class FakeRequest {
    constructor(url, init = {}) { this.url = url; this._body = init.body; }
    clone() { return new FakeRequest(this.url, { body: this._body }); }
    text() { return Promise.resolve(this._body); }
  }
  const exchange = { responseText: "[]" };
  const win = {
    fetch: () => Promise.resolve({ clone: () => ({ text: () => Promise.resolve(exchange.responseText) }) }),
    postMessage: (m) => posted.push(m),
    location: { href: "https://www.twitch.tv/drops/inventory", origin: "https://www.twitch.tv" },
  };
  const loadListeners = [];
  function FakeXHR() { this.responseType = ""; }
  FakeXHR.prototype = {
    open() {}, send() { loadListeners.forEach((fn) => fn.call(this)); },
    addEventListener(type, fn) { if (type === "load") loadListeners.push(fn); },
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, Date, JSON, Math, Set, Map, Promise, RegExp, Object, Array, String, Number, TextDecoder, URL,
    window: win, XMLHttpRequest: FakeXHR, Request: FakeRequest,
  };
  vm.runInContext(readFile("inject.js"), vm.createContext(sandbox));
  const signals = () => JSON.parse(JSON.stringify(posted.map((m) => m.payload.signal)));
  return { win, FakeRequest, FakeXHR, exchange, signals, GQL, loadListeners, sandbox };
}
const claimBody = JSON.stringify([{ operationName: "DropsPage_ClaimDropRewards" }]);
const notLinked = JSON.stringify([{ errors: [{ message: "Connect your Twitch and game accounts to receive this reward in game" }], data: null }]);

async function testInjectReadsRequestObjectsAndNonTextXhr() {
  // fetch(new Request(...)): the body is in the Request
  let w = injectWorld();
  w.exchange.responseText = notLinked;
  await w.win.fetch(new w.FakeRequest(w.GQL, { body: claimBody }));
  await flush();
  assert.deepStrictEqual(w.signals().map((s) => s.kind), ["claimRequest", "claimNotLinked"], "a Request announces its claim and its answer is read: " + JSON.stringify(w.signals()));
  // fetch(new URL(...), init)
  w = injectWorld();
  w.exchange.responseText = notLinked;
  await w.win.fetch(new URL(w.GQL), { method: "POST", body: claimBody });
  await flush();
  assert.deepStrictEqual(w.signals().map((s) => s.kind), ["claimRequest", "claimNotLinked"], "a URL object input is recognised");
  // XHR with responseType json / blob / arraybuffer
  for (const [type, response] of [["json", JSON.parse(notLinked)], ["blob", { text: () => Promise.resolve(notLinked) }], ["arraybuffer", new TextEncoder().encode(notLinked).buffer]]) {
    w = injectWorld();
    const x = new w.FakeXHR();
    Object.defineProperty(x, "responseText", { get() { throw new Error("InvalidStateError"); } }); // what a non-text type does
    x.__dropClaimerIsGql = false;
    x.responseType = type;
    x.response = response;
    x.open("POST", w.GQL);
    x.send(claimBody);
    await flush();
    assert.deepStrictEqual(w.signals().map((s) => s.kind), ["claimRequest", "claimNotLinked"], `XHR responseType ${type}: ${JSON.stringify(w.signals())}`);
  }
  console.log("  OK  C7: fetch(Request / URL) and XHR with responseType json/blob/arraybuffer are read");
}

// ---------------------------------------------------------------------------------------------------- C8 / C9 (claim flow on a jsdom page)
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

async function testTheRetroactiveCheckIsThrottled() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const tab = await openDomTab({ clock, bg, html: cardHtml([tierHtml("Boots", { button: true })]) });
  await tab.scan(); // clicks; the button stays = rejected at the verdict
  await run([tab], 15 * SEC);
  assert.strictEqual(tab.results().filter((m) => m.ok === false).length, 1, "sanity: judged refused, so it is remembered for the retroactive check");
  // many DOM mutations in the same moment: the Claimed list is not re-read for each
  const doc = tab.window.document;
  let reads = 0;
  const orig = doc.querySelectorAll.bind(doc);
  doc.querySelectorAll = (sel) => { if (/game-card-image/.test(sel)) reads++; return orig(sel); };
  for (let i = 0; i < 40; i++) await tab.scan();
  assert.ok(reads <= 2, `40 mutations read the Claimed list ${reads} times (it was 40)`);
  console.log(`  OK  C8: 40 DOM mutations read the Claimed list ${reads}x`);
}

async function testAClickWithoutARequestIsNotPairedWithALaterRequest() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const toast = (id) => `<div data-test-selector="drops-notification" id="t${id}"><button data-test="b${id}">Claim Now</button></div>`;
  const tab = await openDomTab({ clock, bg, html: toast(1), pathname: "/somechannel" });
  await tab.scan(); // click A: no GQL request ever follows it
  assert.deepStrictEqual(tab.clicked, ["b1"]);
  clock.advanceTo(clock.now + 6 * SEC);
  tab.window.document.body.insertAdjacentHTML("beforeend", toast(2)); // a second toast shows up later
  await tab.scan();
  assert.deepStrictEqual(tab.clicked, ["b1", "b2"], "click B");
  tab.signal({ kind: "claimRequest", seq: 1 }); // B's request goes out
  tab.signal({ kind: "claimNotLinked", seq: 1 }); // and Twitch answers: not connected
  await flush();
  await run([tab], 25 * SEC);
  const keysNotLinked = tab.sent.filter((m) => m.type === "claimNotLinked").map((m) => m.key);
  assert.strictEqual(keysNotLinked.length, 1, "one refusal reported: " + JSON.stringify(keysNotLinked));
  assert.ok(/#e2$/.test(keysNotLinked[0]), "for B (the second button), not for A whose click had no request: " + keysNotLinked[0]);
  console.log("  OK  C9: a request pairs with the click it belongs to, not with an older click that had none");
}

(async () => {
  console.log("Running review group C tests...\n");
  try {
    await testAReplayIsNotAnotherMissingScan();
    await testMapsStopGrowing();
    await testALowerCasedPathIsNotARaid();
    await testTheProblemRecheckDoesNotSurviveAnOffOnToggle();
    await testWatchListLinesAreValidated();
    await testInjectReadsRequestObjectsAndNonTextXhr();
    await testTheRetroactiveCheckIsThrottled();
    await testAClickWithoutARequestIsNotPairedWithALaterRequest();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
