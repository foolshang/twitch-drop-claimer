/**
 * review-b-content.test.js - findings B2, B3, B4, B5 of the 0.6.24 code review (content.js)
 *
 *  B2 SPA navigation: a verdict from another page counted as a success; the page-type timers ran once
 *  B3 claim key of a button outside a card = label + position: shared, and shifting
 *  B4 tier length: "1 hour 30 minutes" read as 60, "1.5 hours" unread, a wrapper giving every tier the first length
 *  B5 other UI languages: the progress line read as a reward name, viewer counts ("1,2K", no "viewers" word, a
 *     title's number), the quality menu always "applied", "ends"/"26 Aug" date patterns
 */

const vm = require("vm");
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { SEC, flush, makeClock, makeBackground, run } = require("./claim-harness");
const { openDomTab, readFile } = require("./world-helpers");
const { parseCards, RUST, RUST_ID } = require("./campaign-matching.test.js");

// ---- fixtures ------------------------------------------------------------------------------------------------
const tierHtml = (name, { button = false, percent = 100, progressText } = {}) => `
  <div class="tier">
    <div><div><div><img alt="Reward Image Icon" src="https://static-cdn.jtvnw.net/x.png"></div><div><div><p>${name}</p></div></div></div></div>
    <div><div role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"></div><div><p>${progressText || `<span>${percent}</span>% of 1 hour`}</p></div>
      ${button ? `<button data-test="${name}">Claim Now</button>` : ""}</div>
  </div>`;
const cardHtml = (tiers, id = "camp-1") => `<div class="card">
  <div><p title=""><a href="/drops/campaigns?dropID=${id}">Some Campaign</a></p></div>
  <div><img data-test-selector="DropsCampaignInProgressDescription-game-card-image" alt="Drops Campaign Image" src="https://static-cdn.jtvnw.net/ttv-boxart/${RUST_ID}_IGDB-285x380.jpg"></div>
  <div>${tiers.join("")}</div></div><h5>Claimed</h5><div class="claimed"></div>`;

// ---- B2 ----------------------------------------------------------------------------------------------------------
async function testAVerdictFromAnotherPageIsDropped() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const tab = await openDomTab({ clock, bg, html: cardHtml([tierHtml("Boots", { button: true })]) });
  await tab.scan(); // clicks "Claim Now" on the inventory
  assert.deepStrictEqual(tab.clicked, ["Boots"]);
  tab.navigate("/somechannel"); // the SPA moves to a channel page before the 12 s verdict
  await run([tab], 20 * SEC);
  assert.deepStrictEqual(tab.results(), [], "no verdict at all: neither a success nor a failure: " + JSON.stringify(tab.results()));
  assert.ok(!tab.localSets.some((o) => o.lastClaimAt), "no fake last claim");
  assert.ok(tab.sent.some((m) => m.type === "claimRelease"), "the reward is released for another try");
  console.log("  OK  B2: a claim whose page changed before the verdict is dropped (no fake success)");
}

async function testPageTypeTimersFollowTheCurrentPage() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const tab = await openDomTab({ clock, bg, html: cardHtml([tierHtml("Boots", { percent: 50 })]) });
  const live = () => tab.intervals.filter((i) => !i.cleared);
  const inventoryTimers = () => live().filter((i) => /scrollTo|scanInventory/.test(String(i.fn)));
  assert.ok(inventoryTimers().length >= 1, "sanity: the inventory page runs its scroll/scan timers");
  tab.navigate("/directory/category/rust"); // leaves the inventory
  await tab.scan();
  assert.strictEqual(inventoryTimers().length, 0, "the inventory timers stopped on another page (they sent junk progress)");

  // a page reached by navigation gets its own monitor
  const clock2 = makeClock();
  const bg2 = await makeBackground({ clock: clock2 });
  const tab2 = await openDomTab({ clock: clock2, bg: bg2, html: "<div>home</div>", pathname: "/" });
  const channelMonitors = () => tab2.intervals.filter((i) => !i.cleared && i.ms === 60_000 && /getWatchTabInfo/.test(String(i.fn)));
  assert.strictEqual(channelMonitors().length, 0, "the home page has no channel monitor");
  tab2.navigate("/blooprint");
  await tab2.scan();
  assert.strictEqual(channelMonitors().length, 1, "after navigating to a channel page it has one");
  console.log("  OK  B2: timers restart per page type after an SPA navigation");
}

// ---- B3 ----------------------------------------------------------------------------------------------------------
async function testToastButtonsEachGetTheirOwnStableKey() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const html = `<div data-test-selector="drops-notification"><button data-test="t1">Claim Now</button></div>
                <div data-test-selector="drops-notification"><button data-test="t2">Claim Now</button></div>`;
  const tab = await openDomTab({ clock, bg, html, pathname: "/somechannel" });
  tab.window.document.querySelector('button[data-test="t1"]').addEventListener("click", (e) => e.target.remove()); // the first goes through; the second stays
  await tab.scan();
  await run([tab], 20 * SEC);
  assert.deepStrictEqual(tab.clicked.slice(0, 2).sort(), ["t1", "t2"]);
  const verdicts = Object.fromEntries(tab.results().map((m) => [m.key, m.ok]));
  const keys = Object.keys(verdicts);
  assert.strictEqual(keys.length, 2, "two toasts, two keys: " + JSON.stringify(verdicts));
  assert.deepStrictEqual(Object.values(verdicts).sort(), [false, true], "the one that went through is a success, the one that stayed a failure: " + JSON.stringify(verdicts));
  console.log("  OK  B3: two toasts do not share a key and the verdicts are not flipped when one disappears");
}

// ---- B4 / B5: parse functions of content.js, called directly --------------------------------------------------
function contentGlobals(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://www.twitch.tv/directory/category/rust" });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, configurable: true });
  const timers = [];
  const clock = makeClock();
  const clicks = [];
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    document: window.document, location: window.location, window,
    MutationObserver: window.MutationObserver,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return clock.setTimeout(fn, ms); }, clearTimeout: () => {},
    browser: { storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, onChanged: { addListener() {} } }, runtime: { sendMessage: () => Promise.resolve() } },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFile("shared.js"), ctx);
  const src = readFile("content.js");
  vm.runInContext(src.slice(src.indexOf("(() => {") + 8, src.lastIndexOf("})();")), ctx);
  return { ctx, window, clock, clicks, call: (expr) => vm.runInContext(expr, ctx) };
}

async function testTierLengthIsRead() {
  const tiers = [
    tierHtml("A", { percent: 0, progressText: "0% of 1 hour 30 minutes" }),
    tierHtml("B", { percent: 0, progressText: "0% of 1.5 hours" }),
    tierHtml("C", { percent: 0, progressText: "0% of 90 minutes" }),
  ];
  // all three tiers sit in one `.tw-tower` wrapper (as Twitch's layout classes do)
  const html = cardHtml([`<div class="tw-tower">${tiers.join("")}</div>`]);
  const cards = parseCards({ cards: [html], watchList: [RUST] });
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].timeRemainingMin, 270, "90 + 90 + 90 minutes, each tier by its own text: " + cards[0].timeRemainingMin);
  const g = contentGlobals("<div></div>");
  const mins = (text) => g.call(`extractTierDurationMin({ innerText: ${JSON.stringify(text)} })`);
  assert.strictEqual(mins("40% of 1 hour 30 minutes"), 90);
  assert.strictEqual(mins("40% of 1.5 hours"), 90);
  assert.strictEqual(mins("40% of 2 hours"), 120);
  assert.strictEqual(mins("40% of 45 minutes"), 45);
  assert.strictEqual(mins("40% จาก 4 ชั่วโมง"), 240, "Thai units");
  assert.strictEqual(mins("no percentage here"), null);
  console.log("  OK  B4: hours + minutes added, decimals read, each tier by its own text, Thai units");
}

async function testTheProgressLineIsNeverARewardNameInAnyLanguage() {
  const thaiTierWithoutName = `<div class="tier"><div><div role="progressbar" aria-valuenow="40"></div><div><p>40% จาก 4 ชั่วโมง</p></div></div></div>`;
  const g = contentGlobals(`<div id="host">${thaiTierWithoutName}</div>`);
  const bar = g.window.document.querySelector('[role="progressbar"]');
  g.ctx.__bar = bar;
  assert.strictEqual(g.call("extractTierName(__bar)"), null, "a Thai progress line is not the reward's name");
  const named = contentGlobals(`<div class="tier"><div><p>Boots</p></div><div><div role="progressbar" aria-valuenow="40"></div><div><p>40% จาก 4 ชั่วโมง</p></div></div></div>`);
  named.ctx.__bar = named.window.document.querySelector('[role="progressbar"]');
  assert.strictEqual(named.call("extractTierName(__bar)"), "Boots");
  console.log("  OK  B5: a progress line is skipped by structure and by a leading %, not only by English words");
}

function directory(cards) {
  return `<main>${cards.map((c) => `<article><a data-a-target="preview-card-image-link" href="/${c.name}"></a><p>${c.text}</p></article>`).join("")}</main>`;
}
async function testViewerCountsAreReadSafely() {
  const pick = (cards) => {
    const g = contentGlobals(directory(cards));
    const r = g.call("pickBestChannel([])");
    return r && r.name;
  };
  assert.strictEqual(pick([{ name: "big", text: "5K viewers" }, { name: "small", text: "300 viewers" }, { name: "mid", text: "1,2K viewers" }]), "small", "the fewest viewers");
  assert.strictEqual(pick([{ name: "a", text: "1,2K viewers" }, { name: "b", text: "1,3K viewers" }]), "a", "1,2K is 1200, not 12000");
  assert.strictEqual(pick([{ name: "a", text: "12,345 viewers" }, { name: "b", text: "999 viewers" }]), "b", "a thousands separator is dropped");
  // a title saying "1000 viewers" does not become the count: the line that is only the count wins
  assert.strictEqual(pick([{ name: "a", text: "Road to 1000 viewers giveaway\n250 viewers" }, { name: "b", text: "Chill stream\n400 viewers" }]), "a");
  // nothing readable at all: nothing is picked (it used to pick the FIRST card = the most viewed)
  assert.strictEqual(pick([{ name: "first", text: "ดูตอนนี้" }, { name: "second", text: "ดูตอนนี้" }]), null, "unreadable counts: no pick");
  // some unreadable: they are left out, the readable ones decide
  assert.strictEqual(pick([{ name: "first", text: "ไม่มีตัวเลข" }, { name: "second", text: "700 viewers" }]), "second");
  // Thai wording is understood
  assert.strictEqual(pick([{ name: "a", text: "ผู้ชม 900" }, { name: "b", text: "ผู้ชม 80" }]), "b");
  console.log("  OK  B5: viewer counts: 1,2K = 1200, a title's number ignored, unreadable = no pick (not the most viewed)");
}

async function testTheQualityMenuIsLookedUpInThePlayersMenu() {
  const g = contentGlobals("<div>no player yet</div>");
  assert.strictEqual(g.call("applyLowQuality()"), false, "no settings button yet: not applied, will retry");
  assert.strictEqual(g.call("applyLowQuality()"), false);
  assert.strictEqual(g.call("applyLowQuality()"), false);
  assert.strictEqual(g.call("applyLowQuality()"), false);
  assert.strictEqual(g.call("applyLowQuality()"), true, "after 5 attempts it gives up");

  // with the player: the settings button opens a menu; another "quality" button and other radios sit elsewhere on the page
  const html = `<button data-test="elsewhere">Video quality guide</button><label><input type="radio" data-test="poll1"></label>
                <button data-a-target="player-settings-button" data-test="settings">⚙</button>`;
  const h = contentGlobals(html);
  const doc = h.window.document;
  const clicked = [];
  doc.addEventListener("click", (e) => { const t = e.target.closest("[data-test]"); if (t) clicked.push(t.getAttribute("data-test")); }, true);
  let opened = false;
  doc.querySelector('[data-test="settings"]').addEventListener("click", () => {
    if (opened) return;
    opened = true;
    doc.body.insertAdjacentHTML("beforeend", `<div data-a-target="player-settings-menu"><button data-a-target="player-settings-menu-item-quality" data-test="q-item">คุณภาพ</button></div>`);
    doc.querySelector('[data-test="q-item"]').addEventListener("click", () => {
      doc.querySelector('[data-a-target="player-settings-menu"]').insertAdjacentHTML("beforeend",
        `<label><input type="radio" data-test="auto"></label><label><input type="radio" data-test="p720"></label><label><input type="radio" data-test="p160"></label>`);
    });
  });
  assert.strictEqual(h.call("applyLowQuality()"), true);
  h.clock.advanceTo(h.clock.now + 350);
  await flush();
  h.clock.advanceTo(h.clock.now + 450);
  await flush();
  assert.ok(clicked.includes("q-item"), "the menu's own quality item (a Thai UI) was used: " + JSON.stringify(clicked));
  assert.ok(clicked.includes("p160"), "the lowest option of the menu was chosen: " + JSON.stringify(clicked));
  assert.ok(!clicked.includes("elsewhere") && !clicked.includes("poll1"), "nothing else on the page was touched: " + JSON.stringify(clicked));
  console.log("  OK  B5: the quality menu is the player's own (any UI language); not applied until the settings button exists");
}

async function testEndDatePatternsNeedWordBoundariesAndKnowDayFirst() {
  const g = contentGlobals("<div></div>");
  const ts = (text) => g.call(`extractExpiresAt(${JSON.stringify(text)})`);
  assert.strictEqual(ts("Weekend Oct 5 special"), null, "'Weekend Oct 5' is not 'ends Oct 5'");
  assert.ok(ts("Campaign ends Oct 5") != null, "a real 'ends Oct 5' still works");
  const day = g.call(`new Date(extractExpiresAt("End Date: Wed, 26 Aug, 7:59 AM GMT+7")).getDate()`);
  const month = g.call(`new Date(extractExpiresAt("End Date: Wed, 26 Aug, 7:59 AM GMT+7")).getMonth()`);
  assert.deepStrictEqual([day, month], [26, 7], "'26 Aug' (day first) is read");
  assert.ok(ts("ends 26 Aug") != null, "also after 'ends'");
  console.log("  OK  B5: 'ends' needs a word boundary; day-first dates are read");
}

(async () => {
  console.log("Running review group B (content) tests...\n");
  try {
    await testAVerdictFromAnotherPageIsDropped();
    await testPageTypeTimersFollowTheCurrentPage();
    await testToastButtonsEachGetTheirOwnStableKey();
    await testTierLengthIsRead();
    await testTheProgressLineIsNeverARewardNameInAnyLanguage();
    await testViewerCountsAreReadSafely();
    await testTheQualityMenuIsLookedUpInThePlayersMenu();
    await testEndDatePatternsNeedWordBoundariesAndKnowDayFirst();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
