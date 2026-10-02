/**
 * claim-link-accepted.test.js
 *
 * Seen in real 0.6.19 use: Twitch ACCEPTED a claim (the reward showed up in the inventory's
 * Claimed list minutes later) and then answered "connect your Twitch and game accounts to receive
 * this reward in game". The extension read that answer as a refusal: it stopped claiming that
 * reward, warned that the claim was blocked and did not update "last claimed".
 *
 * That answer only means the reward cannot be delivered in-game until the account is linked. It is
 * judged at the verdict, by what the page shows (the Claimed list, the button, the response status),
 * never by the error text alone:
 *   - accepted -> a success (last claim, backoff reset, claiming goes on) + a reminder to link;
 *   - really refused (not in Claimed, button still there) -> the reward stops, as before.
 *
 * Real content.js on a jsdom page (with a real Claimed section) + the real background.js.
 */

const vm = require("vm");
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { SEC, flush, read, makeClock, makeBackground, run } = require("./claim-harness");

const ORIGIN = "https://www.twitch.tv";
const GAME_ID = "263490";

async function openDomTab({ clock, bg, html }) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: `${ORIGIN}/drops/inventory` });
  const { window } = dom;
  // jsdom has no innerText; extractClaimedCounts reads it
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  const observers = [];
  const sent = [];
  const localSets = [];
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    Set, Map, Promise, URL, JSON, Math, Array, Object, Number, String, RegExp,
    Date: clock.FakeDate,
    window,
    document: window.document,
    location: window.location,
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} },
    setInterval: () => 1, clearInterval() {},
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (t) => clock.clearTimeout(t),
    browser: {
      storage: { local: { get: () => Promise.resolve({ enabled: true, gameIdMap: { [GAME_ID]: "Escape from Tarkov" } }), set: (o) => { localSets.push(o); return Promise.resolve(); } }, onChanged: { addListener() {} } },
      runtime: { sendMessage: (m) => { sent.push(m); return bg.send(m, 1); }, onMessage: { addListener() {} } },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext(read("content.js"), ctx);
  await flush();
  assert.strictEqual(observers.length, 1, "content.js started");
  const signal = (s) => window.dispatchEvent(new window.MessageEvent("message", {
    data: { type: "__DROP_CLAIMER_GQL__", payload: { operationName: "DropsPage_ClaimDropRewards", signal: { ...s, operationName: "DropsPage_ClaimDropRewards" }, at: clock.now } },
    origin: ORIGIN, source: window,
  }));
  const clicks = [];
  window.document.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) clicks.push(b.getAttribute("data-test")); }, true);
  return {
    clock, window, sent, localSets, clicks, signal,
    scan: () => Promise.resolve(observers[0].cb([])),
    results: () => sent.filter((m) => m.type === "claimResult"),
  };
}

function tier(name) {
  return `<div class="tier">
    <div><div><img alt="Reward Image Icon" src="https://static-cdn.jtvnw.net/x.png"></div><div><div><p>${name}</p></div></div></div>
    <div><div role="progressbar" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100"></div><div><p><span>100</span>% of 1 hour</p></div>
      <button data-test="${name}">Claim Now</button></div></div>`;
}
const card = (id, title, tiers) => `<div class="card">
  <div><p title=""><a href="/drops/campaigns?dropID=${id}">${title}</a></p></div>
  <div><img data-test-selector="DropsCampaignInProgressDescription-game-card-image" alt="Drops Campaign Image" src="https://static-cdn.jtvnw.net/ttv-boxart/${GAME_ID}_IGDB-285x380.jpg"></div>
  <div>${tiers.join("")}</div></div>`;
// the Claimed section: its heading and rows (a time line, then the reward's name)
const claimedSection = (names = []) => `<h5>Claimed</h5><div class="claimed">${names.map((n) => `<div class="row"><div><p>3 minutes ago</p></div><div><p>${n}</p></div></div>`).join("")}</div>`;
const addClaimed = (tab, name) => tab.window.document.querySelector(".claimed").insertAdjacentHTML("beforeend", `<div class="row"><div><p>3 minutes ago</p></div><div><p>${name}</p></div></div>`);

async function world(html) {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const tab = await openDomTab({ clock, bg, html });
  return { clock, bg, tab };
}

const REWARD = "Ammo Selection Pack Lv.4";
const KEY = `camp-1:${REWARD}`;

// click -> Twitch's request is reported -> its "connect your accounts" answer is reported
async function clickAndAnswer(tab, signal) {
  await tab.scan();
  await flush();
  assert.strictEqual(tab.clicks[0], REWARD, "the claim button was clicked first (the one whose request is answered)");
  tab.signal({ kind: "claimRequest", seq: 1 });
  tab.signal({ kind: "claimNotLinked", seq: 1, ...signal });
  await flush();
}

async function testAcceptedClaimInClaimedListIsASuccessWithAReminder() {
  const { clock, bg, tab } = await world(card("camp-1", "Tarkov", [tier(REWARD), tier("Other reward")]) + claimedSection());
  // Twitch accepts the claim: the reward lands in the Claimed list (the stale claim button stays in the page for now)
  const stale = tab.window.document.querySelector(`button[data-test="${REWARD}"]`);
  // (the stale button is swapped for Twitch's "Connect" button a moment AFTER the verdict at 12 s)
  stale.addEventListener("click", () => { addClaimed(tab, REWARD); clock.setTimeout(() => stale.remove(), 14 * SEC); });
  tab.window.document.querySelector('button[data-test="Other reward"]').addEventListener("click", (e) => e.target.remove());
  await clickAndAnswer(tab, {});
  await run([tab], 30 * SEC);

  const mine = tab.results().filter((m) => m.key === KEY);
  assert.deepStrictEqual(mine.map((m) => m.ok), [true], "reported to the background as a success: " + JSON.stringify(tab.results()));
  assert.ok(tab.localSets.some((o) => o.lastClaimAt && o.lastClaimText), "last claimed is recorded");
  assert.ok(!bg.local.claimNotLinked || bg.local.claimNotLinked.length === 0, "not 'blocked': " + JSON.stringify(bg.local.claimNotLinked));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bg.local.claimLinkReminders)), [{ key: KEY, game: "Escape from Tarkov", reward: REWARD }], "a reminder instead, with game + reward");
  assert.ok(bg.logLines().some((l) => /claimed "Escape from Tarkov - Ammo Selection Pack Lv\.4".*not linked/.test(l)), "and one log line, by game and reward - not the key");
  assert.ok(!bg.logLines().some((l) => /camp-1:/.test(l)), "the internal key (campaign id) is in no log line");
  assert.strictEqual(bg.entry(KEY), undefined, "no backoff entry: its state is reset");
  assert.strictEqual((bg.local.claimHealth || {}).streak || 0, 0);
  assert.strictEqual((await bg.send({ type: "claimAsk", key: KEY }, 2)).allowed, true, "claiming this reward is not stopped");
  console.log("  OK  claim + 'not linked' + reward in Claimed -> success (last claim, backoff reset) + a link reminder; claiming goes on");
  return { clock, bg, tab };
}

async function testConnectingTheAccountClearsTheReminder() {
  const { bg, tab } = await world(card("camp-1", "Tarkov", [tier(REWARD)]) + claimedSection());
  tab.window.document.querySelector(`button[data-test="${REWARD}"]`).addEventListener("click", (e) => { e.target.remove(); addClaimed(tab, REWARD); });
  await clickAndAnswer(tab, {});
  await run([tab], 30 * SEC);
  assert.strictEqual(bg.local.claimLinkReminders.length, 1);
  await bg.send({ type: "gqlDropSignal", operationName: "ViewerDropsDashboard", signal: { kind: "openCampaigns", operationName: "ViewerDropsDashboard", snapshot: true, games: [{ id: GAME_ID, name: "Escape from Tarkov", active: true, endAt: null, accountConnected: true }] }, at: 0 }, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bg.local.claimLinkReminders)), [], "linked now: the reminder is gone");
  console.log("  OK  the reminder goes away once the campaigns data says the account is connected");
}

async function testButtonGoneIsEnoughWhenClaimedListIsSlow() {
  const { bg, tab } = await world(card("camp-1", "Tarkov", [tier(REWARD)]) + claimedSection());
  tab.window.document.querySelector(`button[data-test="${REWARD}"]`).addEventListener("click", (e) => e.target.remove()); // Claimed list not refreshed yet
  await clickAndAnswer(tab, {});
  await run([tab], 30 * SEC);
  assert.deepStrictEqual(tab.results().map((m) => m.ok), [true]);
  assert.strictEqual(bg.local.claimLinkReminders.length, 1);
  console.log("  OK  the claim button gone counts as accepted even if the Claimed list has not refreshed");
}

async function testResponseStatusSaysClaimed() {
  const { clock, bg, tab } = await world(card("camp-1", "Tarkov", [tier(REWARD)]) + claimedSection());
  // button still there, Claimed list not refreshed - but the response itself says it was claimed
  const stale = tab.window.document.querySelector(`button[data-test="${REWARD}"]`);
  stale.addEventListener("click", () => clock.setTimeout(() => stale.remove(), 14 * SEC)); // swapped after the verdict
  await clickAndAnswer(tab, { status: "DROP_INSTANCE_ALREADY_CLAIMED", claimed: true });
  await run([tab], 30 * SEC);
  assert.deepStrictEqual(tab.results().map((m) => m.ok), [true], "the response status is evidence too");
  assert.strictEqual(bg.local.claimLinkReminders.length, 1);
  console.log("  OK  a response status that says 'claimed' counts as accepted");
}

async function testRealRefusalStillStopsTheReward() {
  const { bg, tab } = await world(card("camp-1", "Tarkov", [tier(REWARD)]) + claimedSection());
  // the button stays, nothing in Claimed: Twitch really refused
  await clickAndAnswer(tab, {});
  await run([tab], 30 * SEC);

  assert.deepStrictEqual({ ...bg.entry(KEY) }, { f: 0, next: 0, stop: true, notLinked: true }, "stopped for the session");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bg.local.claimNotLinked)), [{ key: KEY, game: "Escape from Tarkov", reward: REWARD }], "with the popup warning");
  assert.ok(!bg.local.claimLinkReminders || bg.local.claimLinkReminders.length === 0, "and no 'claimed' reminder");
  assert.ok(!tab.localSets.some((o) => o.lastClaimAt), "no last claim recorded for a refusal");
  assert.ok(!tab.results().some((m) => m.key === KEY), "not reported as a failed attempt");
  assert.strictEqual((bg.local.claimHealth || {}).streak || 0, 0);
  assert.strictEqual((await bg.send({ type: "claimAsk", key: KEY }, 2)).allowed, false);
  console.log("  OK  'not linked' with the reward not in Claimed and the button still there -> stopped + warning, as before");
}

async function testAnOldClaimedEntryDoesNotCountAsEvidence() {
  // the same reward name was claimed earlier (a repeat in another run): only a NEW entry counts
  const { bg, tab } = await world(card("camp-1", "Tarkov", [tier(REWARD)]) + claimedSection([REWARD]));
  await clickAndAnswer(tab, {});
  await run([tab], 30 * SEC);
  assert.deepStrictEqual({ ...bg.entry(KEY) }, { f: 0, next: 0, stop: true, notLinked: true }, "an entry that was already there proves nothing");
  console.log("  OK  an earlier Claimed entry with the same name is not evidence; only a new one is");
}

function testPopupAndPageSignalWiring() {
  const js = read("popup.js"), html = read("popup.html"), inject = read("inject.js");
  assert.ok(/id="linkReminders"/.test(html) && /claimLinkReminders/.test(js) && /claim_link_reminder/.test(js) && /changes\.claimLinkReminders/.test(js), "popup shows the reminder and follows it live");
  const { I18N, I18N_LANGS } = require("../i18n.js");
  for (const { code } of I18N_LANGS) {
    const t = I18N[code].claim_link_reminder;
    assert.ok(t && /\{game\}/.test(t) && /\{reward\}/.test(t), `${code}: claim_link_reminder with {game} and {reward}`);
  }
  assert.ok(/kind: "claimNotLinked", status, claimed: statusSaysClaimed\(status\)/.test(inject), "inject.js forwards the response status");
  console.log("  OK  popup reminder wired in 9 languages; the response status is forwarded with the signal");
}

(async () => {
  console.log("Running claim accepted-but-not-linked tests (real content.js on a jsdom page + real background.js)...\n");
  try {
    await testAcceptedClaimInClaimedListIsASuccessWithAReminder();
    await testConnectingTheAccountClearsTheReminder();
    await testButtonGoneIsEnoughWhenClaimedListIsSlow();
    await testResponseStatusSaysClaimed();
    await testRealRefusalStillStopsTheReward();
    await testAnOldClaimedEntryDoesNotCountAsEvidence();
    testPopupAndPageSignalWiring();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
