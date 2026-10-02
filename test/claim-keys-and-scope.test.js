/**
 * claim-keys-and-scope.test.js
 *
 * Two things seen in a real bug report (v0.6.17):
 *
 * 1. `claim went through: "Reward Image Icon"` - the reward key was the alt text
 *    of the nearest reward image, which on the inventory is the same generic
 *    "Reward Image Icon" on every tier, so every inventory reward shared ONE key
 *    (one backoff, one in-flight lock: a single rejected claim would have stopped
 *    them all). Now the key is the campaign id (the card's title link
 *    /drops/campaigns?dropID=<id>) + the tier's reward name; no name -> campaign
 *    id + the button's order in the card; same name twice -> name + order; a
 *    button outside any card -> its label + its position. Never one shared key.
 *
 * 2. `claim went through: "claim:Claim Bonus"` x46 - the channel-points chest in
 *    the chat was clicked as if it were a drop (and each "success" recorded a
 *    last claim, reloaded the inventory and fed the backoff/streak machinery).
 *    This extension is for drops only: the community-points area is excluded by
 *    where it sits (so it works in every UI language, plus its English label as
 *    a second net), and the claim-label scan is limited to campaign cards on the
 *    inventory page - on a channel page only Twitch's drop-notification /
 *    callout buttons are clicked.
 *
 * Real content.js on a jsdom page + the real background.js; no browser, no network.
 */

const vm = require("vm");
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { SEC, flush, read, makeClock, makeBackground, run } = require("./claim-harness");

// ---- a real-DOM tab: real content.js on a jsdom page, wired to the real background ----------------------
async function openDomTab({ clock, bg, id = 1, html, pathname = "/drops/inventory" }) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const { window } = dom;
  const observers = [];
  const sent = [];
  const localSets = [];
  const myTimers = new Set();
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    Set, Map, Promise, URL, JSON, Math, Array, Object, Number, String, RegExp,
    Date: clock.FakeDate,
    window,
    document: window.document,
    location: { pathname, href: `https://www.twitch.tv${pathname}`, origin: "https://www.twitch.tv" },
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} },
    setInterval: () => 1, clearInterval() {},
    setTimeout: (fn, ms) => { const t = clock.setTimeout(fn, ms); myTimers.add(t); return t; },
    clearTimeout: (t) => { myTimers.delete(t); clock.clearTimeout(t); },
    browser: {
      storage: { local: { get: () => Promise.resolve({ enabled: true, gameIdMap: {} }), set: (o) => { localSets.push(o); return Promise.resolve(); } }, onChanged: { addListener() {} } },
      runtime: { sendMessage: (m) => { sent.push(m); return bg.send(m, id); }, onMessage: { addListener() {} } },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext(read("content.js"), ctx);
  await flush();
  assert.strictEqual(observers.length, 1, "content.js started");
  const clicked = []; // text of every button the extension clicked
  window.document.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) clicked.push(b.getAttribute("data-test") || b.getAttribute("aria-label") || b.textContent.trim()); }, true);
  return {
    id, clock, window, sent, localSets, clicked,
    scan: () => Promise.resolve(observers[0].cb([])),
    results: () => sent.filter((m) => m.type === "claimResult"),
    asks: () => sent.filter((m) => m.type === "claimAsk").map((m) => m.key),
  };
}

// ---- fixtures: real-structure cards with claim buttons ----------------------------------------------------
const GENERIC_ALT = "Reward Image Icon"; // the same alt on every tier of every card (captured real card)
function tier({ name, percent = 100, button = true, id = "", nameless = false }) {
  return `
    <div class="tier">
      <div><div><div><img alt="${GENERIC_ALT}" src="https://static-cdn.jtvnw.net/twitch-quests-assets/REWARD/x.png"></div>${nameless ? "" : `<div><div><p>${name}</p></div></div>`}</div></div>
      <div><div role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"></div><div><p><span>${percent}</span>% of 1 hour</p></div>
        ${button ? `<button data-test="${id || name}">Claim Now</button>` : ""}</div>
    </div>`;
}
function card({ id, title, tiers }) {
  return `
<div class="card">
  <div><p title=""><a href="/drops/campaigns?dropID=${id}">${title}</a></p></div>
  <div><p><span>End Date: </span><span>Mon, Oct 5, 6:58 AM GMT+7</span></p></div>
  <div><img data-test-selector="DropsCampaignInProgressDescription-game-card-image" alt="Drops Campaign Image" src="https://static-cdn.jtvnw.net/ttv-boxart/263490_IGDB-285x380.jpg"></div>
  <div>${tiers.join("\n")}</div>
</div>`;
}

const removeOnClick = (tab, selector) => {
  const b = tab.window.document.querySelector(selector);
  b.addEventListener("click", () => b.remove());
};

async function world(html, pathname) {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const tab = await openDomTab({ clock, bg, html, pathname });
  return { clock, bg, tab };
}

// ---- A: the reward key -------------------------------------------------------------------------------------
async function testEveryInventoryRewardGetsItsOwnKey() {
  const { tab } = await world(
    `<div class="list">${card({ id: "camp-1", title: "Rust Isles Tac Gloves", tiers: [tier({ name: "Tac Gloves" }), tier({ name: "Tac Hoodie" })] })}
     ${card({ id: "camp-2", title: "Rust Isles Boonie", tiers: [tier({ name: "Boonie" })] })}</div>`);
  await tab.scan();
  await flush();
  const keys = tab.asks();
  assert.deepStrictEqual([...keys].sort(), ["camp-1:Tac Gloves", "camp-1:Tac Hoodie", "camp-2:Boonie"], "campaign id + the tier's reward name: " + JSON.stringify(keys));
  assert.ok(!keys.some((k) => /Reward Image Icon/.test(k)), "the generic image alt is never a key");
  console.log("  OK  three inventory rewards, three keys (campaign id + reward name), never the generic alt");
}

async function testOneRejectedRewardDoesNotBlockTheOthers() {
  const { clock, bg, tab } = await world(
    `<div class="list">${card({ id: "camp-1", title: "Rust Isles Tac Gloves", tiers: [tier({ name: "Stuck reward" }), tier({ name: "Fine reward" })] })}</div>`);
  removeOnClick(tab, 'button[data-test="Fine reward"]'); // a claim that goes through: the button vanishes
  await tab.scan();
  await flush();
  await run([tab], 25 * SEC); // verdicts: "Stuck reward" rejected (its button stays), "Fine reward" claimed

  assert.deepStrictEqual(tab.results().map((m) => [m.key, m.ok]).sort(), [["camp-1:Fine reward", true], ["camp-1:Stuck reward", false]], "each reward has its own verdict");
  assert.strictEqual(bg.entry("camp-1:Stuck reward").f, 1, "only the rejected reward is backing off");
  assert.strictEqual(bg.entry("camp-1:Fine reward"), undefined);

  // a new reward shows up while the other is backing off: claimed at once (with one shared key it would be held back)
  const doc = tab.window.document;
  doc.querySelector(".list").insertAdjacentHTML("beforeend", card({ id: "camp-2", title: "Rust Isles Boonie", tiers: [tier({ name: "Boonie" })] }));
  const clicksBefore = tab.clicked.length;
  await run([tab], 10 * SEC);
  assert.ok(tab.clicked.slice(clicksBefore).includes("Boonie"), "the new reward is claimed while 'Stuck reward' backs off: " + JSON.stringify(tab.clicked));
  assert.ok(!tab.clicked.slice(clicksBefore).includes("Stuck reward"), "and the rejected one is left alone");
  console.log("  OK  one rejected reward backs off alone; the others are claimed meanwhile");
}

async function testFallbackKeysAreStillPerReward() {
  // no readable name: campaign id + order
  const noName = await world(`<div class="list">${card({ id: "camp-9", title: "X", tiers: [tier({ name: "", nameless: true, id: "a" }), tier({ name: "", nameless: true, id: "b" })] })}</div>`);
  await noName.tab.scan(); await flush();
  assert.deepStrictEqual([...noName.tab.asks()].sort(), ["camp-9:#0", "camp-9:#1"], "campaign id + the button's order in the card");

  // the same name on two tiers: name + order
  const dup = await world(`<div class="list">${card({ id: "camp-8", title: "X", tiers: [tier({ name: "Boots", id: "a" }), tier({ name: "Boots", id: "b" }), tier({ name: "Hat", id: "c" })] })}</div>`);
  await dup.tab.scan(); await flush();
  assert.deepStrictEqual([...dup.tab.asks()].sort(), ["camp-8:Boots#0", "camp-8:Boots#1", "camp-8:Hat"]);

  // a button outside any card (a drop notification toast): label + position, never shared
  const toast = await world(
    `<div data-test-selector="drops-notification"><button data-test="n1">Claim Now</button></div>
     <div data-test-selector="drops-notification"><button data-test="n2">Claim Now</button></div>`, "/somechannel");
  await toast.tab.scan(); await flush();
  const keys = toast.tab.asks();
  assert.strictEqual(new Set(keys).size, 2, "two toasts, two keys: " + JSON.stringify(keys));
  assert.ok(keys.every((k) => /^claim:Claim Now#\d+$/.test(k)));
  console.log("  OK  fallback keys: campaign id + order, name + order for duplicates, label + position outside a card - never one shared key");
}

// ---- B: drops only ---------------------------------------------------------------------------------------------
async function testChannelPointsBonusIsNeverClicked() {
  const html = `
    <div class="chat-input">
      <div class="community-points-summary">
        <button data-test="bonus-en" aria-label="Claim Bonus" class="claimable-bonus__icon">Claim Bonus</button>
      </div>
      <div data-test-selector="community-points-summary">
        <button data-test="bonus-th" aria-label="รับโบนัส">รับ</button>
      </div>
    </div>
    <button data-test="loose-claim" aria-label="Claim">Claim</button>
    <button data-test="prime" aria-label="Claim Prime reward">Claim Prime reward</button>
    <div data-test-selector="drops-notification"><button data-test="drop-claim" data-a-target="drops-claim-button">Claim Now</button></div>`;
  const { bg, tab } = await world(html, "/somechannel");
  removeOnClick(tab, 'button[data-test="drop-claim"]'); // the real drop claim goes through
  await tab.scan();
  await flush();
  await run([tab], 25 * SEC);

  assert.deepStrictEqual(tab.clicked, ["drop-claim"], "only the drop's own claim button is clicked: " + JSON.stringify(tab.clicked));
  assert.ok(!tab.asks().some((k) => /Bonus|รับ/.test(k)), "the bonus never even reaches the claim gate");
  assert.ok(!tab.sent.some((m) => m.type === "claimResult" && /Bonus|รับ/.test(m.key || "")), "no verdict for it");
  // the real drop was verified normally; nothing about the bonus fed lastClaim / the inventory reload / backoff / streak
  const bonusLast = tab.localSets.filter((o) => o.lastClaimText && /Bonus|รับ/.test(o.lastClaimText));
  assert.deepStrictEqual(bonusLast, [], "never recorded as the last claim");
  assert.ok(!bg.entry("claim:Claim Bonus#0") && !bg.entry("claim:Claim Bonus#1"), "no backoff state for it");
  assert.ok(!(bg.local.claimHealth && bg.local.claimHealth.streak), "the claim-failure streak is untouched");
  console.log("  OK  channel page: the Claim Bonus chest (English and Thai, found by its place in the chat) is not clicked, nor any loose 'claim' button");
}

async function testBonusLookalikesAreNotClickedEvenWithoutTheCommunityPointsMarkup() {
  // Twitch changes class names: the label is the second net
  const { tab } = await world(`<button data-test="bonus" aria-label="Claim Bonus">Claim Bonus</button><div data-test-selector="drops-notification"><button data-test="drop">Claim Now</button></div>`, "/somechannel");
  await tab.scan(); await flush();
  assert.ok(!tab.clicked.includes("bonus"), "a 'Claim Bonus' button is never clicked");
  console.log("  OK  a Claim Bonus button is not clicked even if its surrounding markup is not recognised");
}

async function testInventoryOnlyClaimsButtonsInsideCampaignCards() {
  const html = `
    <header><button data-test="header-claim" aria-label="Claim">Claim</button><button data-test="watch" aria-label="รับชม">รับชม</button></header>
    ${card({ id: "camp-1", title: "Rust Isles Tac Gloves", tiers: [tier({ name: "Tac Gloves" })] })}
    <div class="community-points-summary"><button data-test="bonus" aria-label="Claim Bonus">Claim Bonus</button></div>
    <div class="elsewhere"><button data-test="elsewhere">Claim Now</button></div>`;
  const { tab } = await world(html);
  await tab.scan(); await flush();
  assert.deepStrictEqual(tab.clicked, ["Tac Gloves"], "only the claim button inside the campaign card: " + JSON.stringify(tab.clicked));
  console.log("  OK  inventory: only claim buttons inside campaign cards are clicked - not a header 'Claim', not 'รับชม…', not a loose 'Claim Now'");
}

async function testNoLooseScanOnChannelPages() {
  const { tab } = await world(`<button data-test="a">Claim</button><button data-test="b" aria-label="Claim Now">Claim Now</button><button data-test="c" aria-label="รับรางวัล">รับรางวัล</button>`, "/somechannel");
  await tab.scan(); await flush();
  assert.deepStrictEqual(tab.clicked, [], "a channel page is not scanned for claim-labelled buttons: " + JSON.stringify(tab.clicked));
  // but the chat callout and the notification are still honoured
  const w = await world(`<div data-test-selector="chat-private-callout"><button data-test="callout">Claim Now</button></div>
    <div data-test-selector="drops-notification"><button data-test="note">Claim</button></div>`, "/somechannel");
  await w.tab.scan(); await flush();
  assert.deepStrictEqual([...w.tab.clicked].sort(), ["callout", "note"]);
  console.log("  OK  channel pages: no scan of every button; the drop notification and the chat callout still work");
}

(async () => {
  console.log("Running claim key / claim scope tests (real content.js on a jsdom page + real background.js)...\n");
  try {
    await testEveryInventoryRewardGetsItsOwnKey();
    await testOneRejectedRewardDoesNotBlockTheOthers();
    await testFallbackKeysAreStillPerReward();
    await testChannelPointsBonusIsNeverClicked();
    await testBonusLookalikesAreNotClickedEvenWithoutTheCommunityPointsMarkup();
    await testInventoryOnlyClaimsButtonsInsideCampaignCards();
    await testNoLooseScanOnChannelPages();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
