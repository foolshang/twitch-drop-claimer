/**
 * claim-display-and-retro.test.js
 *
 * Found in real 0.6.19 use:
 *  1. the popup's account-link warning showed the internal claim key
 *     "5fd08c9d-4a0e-...:Ammo Selection Pack Lv.4" (campaign id : reward) - it must read
 *     "<game> - <reward>" (game from the Inventory GQL by campaign id, else from the card),
 *     the reward alone when the game is unknown, never the campaign id; likewise in the log;
 *  2. "Last claimed" showed the button text ("Claim Now") - it must be the reward's name;
 *  3. a claim judged refused at the 12 s verdict because the Claimed list was slow stayed
 *     stopped for the whole session - a later scan that finds the reward in Claimed must count
 *     it as a success after all (stop/backoff cleared, warning withdrawn, last claim recorded,
 *     and the link reminder when the cause was an unlinked game account).
 *
 * Real content.js on a jsdom page + real background.js + real popup.html/popup.js.
 */

const vm = require("vm");
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { SEC, flush, read, makeClock, makeBackground, run } = require("./claim-harness");

const ORIGIN = "https://www.twitch.tv";
const GAME_ID = "263490";
const UUID = "5fd08c9d-4a0e-4df3-b4fd-fec13e0f39d6";
const REWARD = "Ammo Selection Pack Lv.4";
const KEY = `${UUID}:${REWARD}`;
const hasUuid = (s) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(s);

// ---- a tab with a real DOM (as in claim-link-accepted.test.js) ------------------------------------------
async function openDomTab({ clock, bg, html }) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: `${ORIGIN}/drops/inventory` });
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
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (t) => clock.clearTimeout(t),
    browser: {
      storage: { local: { get: () => Promise.resolve({ enabled: true, gameIdMap: { [GAME_ID]: "Delta Force" } }), set: (o) => { localSets.push(o); return Promise.resolve(); } }, onChanged: { addListener() {} } },
      runtime: { sendMessage: (m) => { sent.push(m); return bg.send(m, 1); }, onMessage: { addListener() {} } },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext(read("content.js"), ctx);
  await flush();
  const signal = (s) => window.dispatchEvent(new window.MessageEvent("message", {
    data: { type: "__DROP_CLAIMER_GQL__", payload: { operationName: "DropsPage_ClaimDropRewards", signal: { ...s, operationName: "DropsPage_ClaimDropRewards" }, at: clock.now } },
    origin: ORIGIN, source: window,
  }));
  return { clock, window, sent, localSets, signal, scan: () => Promise.resolve(observers[0].cb([])), results: () => sent.filter((m) => m.type === "claimResult") };
}

const tier = (name) => `<div class="tier">
    <div><div><img alt="Reward Image Icon" src="https://static-cdn.jtvnw.net/x.png"></div>${name ? `<div><div><p>${name}</p></div></div>` : ""}</div>
    <div><div role="progressbar" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100"></div><div><p><span>100</span>% of 1 hour</p></div>
      <button data-test="${name || "unnamed"}">Claim Now</button></div></div>`;
const card = (tiers) => `<div class="card">
  <div><p title=""><a href="/drops/campaigns?dropID=${UUID}">Delta Force Hawk Ops</a></p></div>
  <div><img data-test-selector="DropsCampaignInProgressDescription-game-card-image" alt="Drops Campaign Image" src="https://static-cdn.jtvnw.net/ttv-boxart/${GAME_ID}_IGDB-285x380.jpg"></div>
  <div>${tiers.join("")}</div></div><h5>Claimed</h5><div class="claimed"></div>`;
const addClaimed = (tab, name) => tab.window.document.querySelector(".claimed").insertAdjacentHTML("beforeend", `<div class="row"><div><p>3 minutes ago</p></div><div><p>${name}</p></div></div>`);

async function world(tiers) {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const tab = await openDomTab({ clock, bg, html: card(tiers) });
  return { clock, bg, tab };
}

// ---- popup ------------------------------------------------------------------------------------------------
async function renderPopup(storage) {
  const dom = new JSDOM(read("popup.html").replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, ""), { runScripts: "outside-only", url: "moz-extension://test/popup.html" });
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
    storage: { local: { get: (k) => Promise.resolve(pick(k)), set: () => Promise.resolve() }, session: { get: () => Promise.resolve({}) }, onChanged: { addListener() {} } },
    runtime: { sendMessage: () => Promise.resolve({}), getManifest: () => ({ version: "0.0.0-test" }) },
    tabs: { query: () => Promise.resolve([]), create() {} },
  };
  Object.defineProperty(w.navigator, "language", { value: "en-US" });
  w.eval([read("i18n.js"), read("shared.js"), read("popup.js")].join("\n"));
  await new Promise((r) => setTimeout(r, 60));
  const text = (id) => [...w.document.querySelectorAll(`#${id} .claim-warning`)].map((d) => d.textContent);
  return { notLinked: text("notLinkedWarnings"), reminders: text("linkReminders") };
}

async function testPopupShowsGameAndRewardNeverTheKey() {
  const { notLinked, reminders } = await renderPopup({
    claimNotLinked: [
      { key: KEY, game: "Delta Force", reward: REWARD }, // as stored by 0.6.20
      { key: `${UUID}:Boonie`, game: null, reward: "Boonie" }, // game unknown: the reward alone
      { key: `${UUID}:Gloves`, game: "Rust" }, // as stored by 0.6.19: no reward field, only the key
      { key: `${UUID}:#2`, game: null }, // nothing readable at all
    ],
    claimLinkReminders: [{ key: KEY, game: "Delta Force", reward: REWARD }, { key: `${UUID}:Boonie`, game: null, reward: null }],
  });
  assert.strictEqual(notLinked.length, 4);
  assert.ok(notLinked[0].includes("Delta Force - Ammo Selection Pack Lv.4"), "game - reward: " + notLinked[0]);
  assert.ok(notLinked[1].includes("Boonie") && !/ - Boonie/.test(notLinked[1]), "the reward alone when the game is unknown: " + notLinked[1]);
  assert.ok(notLinked[2].includes("Rust - Gloves"), "a warning stored without a reward still reads from its key: " + notLinked[2]);
  for (const t of [...notLinked, ...reminders]) assert.ok(!hasUuid(t), "no campaign id in the popup: " + t);
  assert.ok(reminders[0].includes("Delta Force") && reminders[0].includes(REWARD), reminders[0]);
  assert.ok(reminders[1].includes("Boonie") && !hasUuid(reminders[1]), reminders[1]);
  console.log("  OK  popup: '<game> - <reward>', the reward alone without a game, never the campaign id");
}

async function testBackgroundResolvesTheGameFromTheInventoryByCampaignId() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  await bg.send({
    type: "gqlDropSignal", operationName: "Inventory", at: 0,
    signal: { kind: "inventoryCampaigns", operationName: "Inventory", campaigns: [{ id: UUID, name: "Delta Force Hawk Ops", status: "ACTIVE", endAt: null, gameId: GAME_ID, gameName: "Delta Force", channels: null }] },
  }, 1);
  // the tab could not read the game off the card (no game id): the Inventory still knows it by campaign id
  await bg.send({ type: "claimNotLinked", key: KEY, game: null, reward: REWARD }, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bg.local.claimNotLinked)), [{ key: KEY, game: "Delta Force", reward: REWARD }]);
  await bg.send({ type: "claimLinkReminder", key: `${UUID}:Boonie`, game: null, reward: null }, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bg.local.claimLinkReminders)), [{ key: `${UUID}:Boonie`, game: "Delta Force", reward: "Boonie" }], "a reward name is read from the key if the tab sent none");
  // and the log says it by name too, in every line that mentions the claim
  for (let i = 0; i < 4; i++) { await bg.send({ type: "claimAsk", key: `${UUID}:Gloves` }, 1); await bg.send({ type: "claimResult", key: `${UUID}:Gloves`, ok: false }, 1); clock.advanceTo(clock.now + 20 * 60 * SEC); }
  await bg.send({ type: "claimResult", key: `${UUID}:Gloves`, ok: true }, 1);
  const lines = bg.logLines().filter((l) => /claim/.test(l) && !/\[openCampaigns\]/.test(l));
  assert.ok(lines.length >= 6, "the claim lines exist: " + lines.length);
  assert.ok(lines.every((l) => !hasUuid(l)), "no campaign id in any user-facing log line: " + lines.filter(hasUuid).join(" | "));
  assert.ok(lines.some((l) => /not retrying "Delta Force - Ammo Selection Pack Lv\.4"/.test(l)), "the not-linked line");
  assert.ok(lines.some((l) => /backing off .* for "Delta Force - Gloves"/.test(l)), "the backoff line");
  console.log("  OK  the game comes from the Inventory by campaign id; no log line carries the campaign id");
}

// ---- Last claimed -----------------------------------------------------------------------------------------
async function testLastClaimedIsTheRewardName() {
  const { tab } = await world([tier(REWARD)]);
  tab.window.document.querySelector(`button[data-test="${REWARD}"]`).addEventListener("click", (e) => e.target.remove());
  await tab.scan(); await flush();
  await run([tab], 25 * SEC);
  const last = tab.localSets.filter((o) => o.lastClaimText).map((o) => o.lastClaimText);
  assert.deepStrictEqual(last, [REWARD], "the reward's name, not 'Claim Now': " + JSON.stringify(last));

  // a tier whose name cannot be read: the button text is the fallback
  const unnamed = await world([tier(null)]);
  unnamed.tab.window.document.querySelector('button[data-test="unnamed"]').addEventListener("click", (e) => e.target.remove());
  await unnamed.tab.scan(); await flush();
  await run([unnamed.tab], 25 * SEC);
  assert.deepStrictEqual(unnamed.tab.localSets.filter((o) => o.lastClaimText).map((o) => o.lastClaimText), ["Claim Now"], "no name anywhere: the button text");

  // the accepted-but-not-linked path records the name too
  const link = await world([tier(REWARD)]);
  const b = link.tab.window.document.querySelector(`button[data-test="${REWARD}"]`);
  b.addEventListener("click", (e) => e.target.remove());
  await link.tab.scan(); await flush();
  link.tab.signal({ kind: "claimRequest", seq: 1 });
  link.tab.signal({ kind: "claimNotLinked", seq: 1 });
  await flush();
  await run([link.tab], 25 * SEC);
  assert.deepStrictEqual(link.tab.localSets.filter((o) => o.lastClaimText).map((o) => o.lastClaimText), [REWARD]);
  console.log("  OK  Last claimed = the reward's name (button text only when no name can be found)");
}

// ---- a slow Claimed list ----------------------------------------------------------------------------------
async function testALateClaimedEntryTurnsARefusalIntoASuccess() {
  // Twitch said "not linked", the button stays, the Claimed list shows the reward only 20 s after the click (verdict: 12 s)
  const { clock, bg, tab } = await world([tier(REWARD)]);
  const btn = tab.window.document.querySelector(`button[data-test="${REWARD}"]`);
  btn.addEventListener("click", () => { clock.setTimeout(() => addClaimed(tab, REWARD), 20 * SEC); clock.setTimeout(() => btn.remove(), 25 * SEC); });
  await tab.scan(); await flush();
  tab.signal({ kind: "claimRequest", seq: 1 });
  tab.signal({ kind: "claimNotLinked", seq: 1 });
  await flush();
  await run([tab], 15 * SEC); // the verdict at 12 s: refused
  assert.strictEqual(bg.entry(KEY).stop, true, "judged refused for now");
  assert.strictEqual(bg.local.claimNotLinked.length, 1);
  assert.ok(!tab.localSets.some((o) => o.lastClaimAt));

  await run([tab], 30 * SEC); // the Claimed list updates; a later scan finds it
  assert.strictEqual(bg.entry(KEY), undefined, "stop/backoff cleared");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bg.local.claimNotLinked)), [], "the refusal warning is withdrawn");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bg.local.claimLinkReminders)), [{ key: KEY, game: "Delta Force", reward: REWARD }], "the link reminder takes its place");
  assert.ok(tab.localSets.some((o) => o.lastClaimAt && o.lastClaimText === REWARD), "last claim recorded, by name");
  assert.strictEqual((bg.local.claimHealth || {}).streak || 0, 0);
  assert.ok(!(bg.local.claimHealth.stopped || []).includes(KEY));
  assert.strictEqual((await bg.send({ type: "claimAsk", key: KEY }, 2)).allowed, true, "not stopped any more");
  console.log("  OK  a refusal (not linked) is turned into a success + reminder when the reward shows up in Claimed later");
}

async function testALateClaimedEntryAlsoRescuesAnOrdinaryRejection() {
  const { clock, bg, tab } = await world([tier(REWARD)]);
  const btn = tab.window.document.querySelector(`button[data-test="${REWARD}"]`);
  btn.addEventListener("click", () => { clock.setTimeout(() => addClaimed(tab, REWARD), 20 * SEC); clock.setTimeout(() => btn.remove(), 25 * SEC); });
  await tab.scan(); await flush();
  await run([tab], 15 * SEC); // no "not linked" answer, the button is still there: a rejection, backing off
  assert.strictEqual(bg.entry(KEY).f, 1);
  assert.strictEqual(bg.local.claimHealth.streak, 1);
  await run([tab], 30 * SEC);
  assert.strictEqual(bg.entry(KEY), undefined, "backoff cleared");
  assert.strictEqual(bg.local.claimHealth.streak, 0, "the failure no longer counts");
  assert.ok(tab.localSets.some((o) => o.lastClaimAt && o.lastClaimText === REWARD));
  assert.ok(!bg.local.claimLinkReminders || bg.local.claimLinkReminders.length === 0, "no reminder: the account was not the cause");
  console.log("  OK  a rejected claim that shows up in Claimed later is counted as a success (no reminder)");
}

async function testARewardThatNeverShowsUpStaysRefused() {
  const { bg, tab } = await world([tier(REWARD)]);
  await tab.scan(); await flush();
  tab.signal({ kind: "claimRequest", seq: 1 });
  tab.signal({ kind: "claimNotLinked", seq: 1 });
  await flush();
  await run([tab], 120 * SEC);
  assert.strictEqual(bg.entry(KEY).stop, true, "still refused");
  assert.strictEqual(bg.local.claimNotLinked.length, 1);
  assert.ok(!tab.localSets.some((o) => o.lastClaimAt));
  console.log("  OK  without a Claimed entry the refusal stands");
}

(async () => {
  console.log("Running claim display / late-Claimed tests (real content.js + background.js + popup.js)...\n");
  try {
    await testPopupShowsGameAndRewardNeverTheKey();
    await testBackgroundResolvesTheGameFromTheInventoryByCampaignId();
    await testLastClaimedIsTheRewardName();
    await testALateClaimedEntryTurnsARefusalIntoASuccess();
    await testALateClaimedEntryAlsoRescuesAnOrdinaryRejection();
    await testARewardThatNeverShowsUpStaysRefused();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
