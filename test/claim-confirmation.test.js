/**
 * claim-confirmation.test.js
 *
 * Seen in real use: a campaign fully claimed showed "done" with the count 4/5. Once
 * the last tier is claimed its card leaves "In Progress", and the missing-card
 * reconciliation marked the entry complete from "the card vanished for several
 * scans + the Inventory GQL no longer lists it" alone: it never looked at the
 * Claimed section and never raised `claimed` to `total`. 0.6.19:
 *   - the card record keeps the reward name of every tier (and whether it counted
 *     as claimed); the entry's progress keeps all names;
 *   - when the card vanishes the names are checked against the Claimed section
 *     with 0.6.8's one-for-one rule (a name on two tiers needs two Claimed entries):
 *       all listed  -> CONFIRMED: claimed = total, allComplete, tab closed;
 *       some missing -> "probably done - not confirmed": nothing closed, nothing
 *         counted as finished, until the Claimed section shows them or
 *         PROBABLY_DONE_TIMEOUT_MS (30 min) passes with no card back and the GQL
 *         still not listing the campaign - then accepted, logged as INFERRED;
 *   - the popup shows total/total for a finished entry.
 * Real content.js (jsdom) + background.js + popup.js; no browser, no network.
 */

const vm = require("vm");
const assert = require("assert");
const { parseCards, world, claimedSection, renderPopupRows, RUST, GENERAL, gqlCampaign, RUST_ID } = require("./campaign-matching.test.js");

// a card with several reward tiers, shaped like the captured real one
function tieredCard({ campaign, tiers }) {
  const tierHtml = tiers.map((t) => `
    <div class="tier">
      <div><div><div><img alt="Reward Image Icon" src="https://static-cdn.jtvnw.net/twitch-quests-assets/REWARD/x.png"></div><div><div><p>${t.name}</p></div></div></div></div>
      <div><div role="progressbar" aria-valuenow="${t.percent}" aria-valuemin="0" aria-valuemax="100"></div><div><p><span>${t.percent}</span>% of 1 hour</p></div></div>
    </div>`).join("\n");
  return `
<div class="card">
  <div>
    <div><p title=""><a href="/drops/campaigns?dropID=${campaign.id}">${campaign.name}</a></p></div>
    <div><p><span>End Date: </span><span>Mon, Oct 5, 6:58 AM GMT+7</span></p></div>
    <div><div><img data-test-selector="DropsCampaignInProgressDescription-game-card-image" alt="Drops Campaign Image" src="https://static-cdn.jtvnw.net/ttv-boxart/${RUST_ID}_IGDB-285x380.jpg"></div>
      <div><div><p>To continue the progress, go to <a href="/directory/category/rust?filter=drops">a participating live channel</a></p></div></div></div>
  </div>
  <div>${tierHtml}</div>
</div>`;
}

const names = (n, prefix = "Reward") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
const watchList = [RUST];
const KEY = "rust";

// last visible reading: tiers 1-4 claimed (100% and listed in Claimed), tier 5 at 80%
async function readingWithFourOfFive(w, rewardNames = names(5)) {
  const cards = parseCards({
    cards: [tieredCard({ campaign: GENERAL, tiers: rewardNames.map((name, i) => ({ name, percent: i < 4 ? 100 : 80 })) })],
    claimed: rewardNames.slice(0, 4), watchList,
  });
  await w.gql([gqlCampaign(GENERAL)]);
  await w.scan(cards, rewardNames.slice(0, 4).map((n) => [n, 1]));
  return cards;
}
const open = (w) => Object.assign(w.bg.local, { watchTabs: { [KEY]: 11 }, watchMeta: { [KEY]: { channel: "someone", tabId: 11 } } });
const REQUIRED = (w) => vm.runInContext("REQUIRED_MISSING_SCANS", w.bg.ctx);

async function testTheCardParserKeepsEveryTiersNameAndClaimedFlag() {
  const cards = parseCards({
    cards: [tieredCard({ campaign: GENERAL, tiers: [{ name: "Boots", percent: 100 }, { name: "Boots", percent: 100 }, { name: "Hat", percent: 40 }] })],
    claimed: ["Boots"], watchList, // only ONE Boots in the Claimed section
  });
  assert.strictEqual(cards.length, 1);
  assert.deepStrictEqual(cards[0].tiers, [
    { name: "Boots", claimed: true },
    { name: "Boots", claimed: false }, // 100% but there is no second Boots in Claimed (one-for-one, as in 0.6.8)
    { name: "Hat", claimed: false },
  ]);
  assert.strictEqual(cards[0].claimed, 1);
  console.log("  OK  content.js: every tier's reward name and claimed flag is kept (duplicate names matched one-for-one)");
}

async function testAVanishedCardWithItsLastRewardInClaimedIsConfirmedFiveOfFive() {
  const w = await world({ watchList });
  open(w);
  await readingWithFourOfFive(w);
  let p = w.progress(KEY);
  assert.deepStrictEqual([p.claimed, p.total], [4, 5], "sanity: the last visible reading is 4/5");
  assert.deepStrictEqual([...p.tierNames], names(5), "all five reward names are kept");

  // the last tier is claimed: the card leaves In Progress, and Claimed lists all five
  await w.gql([]);
  const all = names(5).map((n) => [n, 1]);
  for (let i = 0; i < REQUIRED(w); i++) await w.scan([], all);
  p = w.progress(KEY);
  assert.strictEqual(p.allComplete, true, "confirmed done");
  assert.deepStrictEqual([p.claimed, p.total], [5, 5], "and counted 5/5, not 4/5");
  assert.ok(!p.probablyDone && !p.inferredDone, "confirmed, not inferred");
  assert.ok(!w.bg.local.watchTabs[KEY], "its tab is closed");
  assert.ok(w.bg.logLines().some((l) => /confirmed fully claimed \(5\/5\)/.test(l)));
  console.log("  OK  card vanishes with reward 5 in Claimed: confirmed, 5/5, tab closed");
}

async function testAVanishedCardWithoutItsLastRewardIsOnlyProbablyDone() {
  const w = await world({ watchList });
  open(w);
  await readingWithFourOfFive(w);
  await w.gql([]);
  const four = names(5).slice(0, 4).map((n) => [n, 1]); // reward 5 is NOT in Claimed (yet)
  for (let i = 0; i < REQUIRED(w) + 3; i++) await w.scan([], four);
  let p = w.progress(KEY);
  assert.strictEqual(p.allComplete, false, "not confirmed: not done");
  assert.strictEqual(p.probablyDone, true, "probably done");
  assert.strictEqual(p.claimed, 4, "the count is not raised without confirmation");
  assert.ok(w.bg.local.watchTabs[KEY], "its tab stays open");
  assert.strictEqual(w.done(KEY), false, "and the scheduler does not treat it as finished");
  assert.ok(w.bg.logLines().some((l) => /probably done, not confirmed/.test(l)), "logged once, clearly");
  const probablyLines = w.bg.logLines().filter((l) => /probably done, not confirmed/.test(l)).length;
  await w.scan([], four);
  assert.strictEqual(w.bg.logLines().filter((l) => /probably done, not confirmed/.test(l)).length, probablyLines, "not logged again on every scan");

  // the Claimed section catches up: confirmed
  await w.scan([], names(5).map((n) => [n, 1]));
  p = w.progress(KEY);
  assert.strictEqual(p.allComplete, true);
  assert.deepStrictEqual([p.claimed, p.total], [5, 5]);
  assert.ok(!p.probablyDone);
  assert.ok(!w.bg.local.watchTabs[KEY], "closed once confirmed");
  console.log("  OK  card vanishes without reward 5 in Claimed: probably done, tab kept open, confirmed when Claimed shows it");
}

async function testTheTimeoutAcceptsItAsInferredAndAReturningCardCancelsIt() {
  // timeout: no card back, the GQL does not list it, Claimed never shows reward 5 -> accepted after 30 min, logged as inferred
  const w = await world({ watchList });
  open(w);
  await readingWithFourOfFive(w);
  await w.gql([]);
  const four = names(5).slice(0, 4).map((n) => [n, 1]);
  for (let i = 0; i < REQUIRED(w); i++) await w.scan([], four);
  assert.strictEqual(w.progress(KEY).probablyDone, true);
  const timeout = vm.runInContext("PROBABLY_DONE_TIMEOUT_MS", w.bg.ctx);
  assert.strictEqual(timeout, 30 * 60 * 1000, "30 minutes");

  w.bg.local.campaignProgress[KEY].probablyDoneSince = w.clock.now - timeout + 60_000; // one minute short
  await w.scan([], four);
  assert.strictEqual(w.progress(KEY).allComplete, false, "not yet");
  w.bg.local.campaignProgress[KEY].probablyDoneSince = w.clock.now - timeout - 1_000; // just over
  await w.scan([], four);
  const p = w.progress(KEY);
  assert.strictEqual(p.allComplete, true, "accepted as done after the timeout");
  assert.deepStrictEqual([p.claimed, p.total], [5, 5], "claimed = total on this path too");
  assert.strictEqual(p.inferredDone, true, "marked as inferred, not confirmed");
  assert.ok(w.bg.logLines().some((l) => /INFERRED fully claimed \(not confirmed\)/.test(l) && /Reward 5/.test(l)), "logged clearly as inferred");
  assert.ok(!w.bg.local.watchTabs[KEY]);

  // the card comes back: not done at all
  const w2 = await world({ watchList });
  open(w2);
  const cards = await readingWithFourOfFive(w2);
  await w2.gql([]);
  for (let i = 0; i < REQUIRED(w2); i++) await w2.scan([], four);
  assert.strictEqual(w2.progress(KEY).probablyDone, true);
  await w2.gql([gqlCampaign(GENERAL)]);
  await w2.scan(cards, four);
  assert.ok(!w2.progress(KEY).probablyDone && !w2.progress(KEY).allComplete, "the card is back: the 'probably done' is withdrawn");
  assert.strictEqual(w2.progress(KEY).claimed, 4);
  console.log("  OK  30-minute timeout accepts it as inferred (5/5, logged); a returning card withdraws 'probably done'");
}

async function testDuplicateRewardNamesNeedOneClaimedEntryEach() {
  const tiers = [{ name: "Boots", percent: 100 }, { name: "Boots", percent: 100 }, { name: "Hat", percent: 100 }];
  const make = async () => {
    const w = await world({ watchList });
    open(w);
    // last reading: the first Boots and the Hat are claimed, the second Boots is still pending (100%, "Claim Now")
    const cards = parseCards({ cards: [tieredCard({ campaign: GENERAL, tiers })], claimed: ["Boots", "Hat"], watchList });
    await w.gql([gqlCampaign(GENERAL)]);
    await w.scan(cards, [["Boots", 1], ["Hat", 1]]);
    assert.deepStrictEqual([w.progress(KEY).claimed, w.progress(KEY).total], [2, 3], "sanity: 2/3");
    await w.gql([]);
    return w;
  };

  // Claimed lists Boots once and Hat once: two Boots tiers need two entries -> not confirmed
  let w = await make();
  for (let i = 0; i < REQUIRED(w) + 1; i++) await w.scan([], [["Boots", 1], ["Hat", 1]]);
  assert.strictEqual(w.progress(KEY).allComplete, false, "one Boots in Claimed does not cover two Boots tiers");
  assert.strictEqual(w.progress(KEY).probablyDone, true);

  // Boots twice + Hat: confirmed
  w = await make();
  for (let i = 0; i < REQUIRED(w); i++) await w.scan([], [["Boots", 2], ["Hat", 1]]);
  assert.strictEqual(w.progress(KEY).allComplete, true);
  assert.deepStrictEqual([w.progress(KEY).claimed, w.progress(KEY).total], [3, 3]);
  console.log("  OK  a reward name on two tiers needs two entries in Claimed (0.6.8's one-for-one rule)");
}

async function testNothingIsConfirmedWithoutNamesOrAClaimedSection() {
  // a reading without tier names (old data / unreadable) and a scan without the Claimed list never confirm
  const w = await world({ watchList });
  open(w);
  const cards = parseCards({ cards: [tieredCard({ campaign: GENERAL, tiers: [{ name: "Only", percent: 90 }] })], watchList });
  cards[0].tiers = [{ name: null, claimed: false }]; // a tier whose name could not be read
  await w.gql([gqlCampaign(GENERAL)]);
  await w.scan(cards, []);
  await w.gql([]);
  for (let i = 0; i < REQUIRED(w) + 2; i++) await w.scan([], [["Only", 1]]);
  assert.strictEqual(w.progress(KEY).allComplete, false, "an unreadable tier name can never be confirmed");
  assert.strictEqual(w.progress(KEY).probablyDone, true);

  const w2 = await world({ watchList });
  open(w2);
  await readingWithFourOfFive(w2);
  await w2.gql([]);
  for (let i = 0; i < REQUIRED(w2) + 2; i++) await w2.scan([]); // the scan carries no Claimed list
  assert.strictEqual(w2.progress(KEY).allComplete, false, "without the Claimed section nothing is confirmed");
  assert.strictEqual(w2.progress(KEY).probablyDone, true);
  console.log("  OK  unreadable names or a missing Claimed list never confirm");
}

async function testPopupShowsTotalOverTotalAndProbablyDone() {
  const en = require("../i18n.js").I18N.en;
  const row = async (progress) => (await renderPopupRows({ watchList, watchTabs: {}, campaignProgress: { [KEY]: progress } }))[0];

  // a finished entry is total/total even if an older reading still carried 4
  let r = await row({ label: "Rust", claimed: 4, total: 5, allComplete: true, expired: false, updatedAt: 1 });
  assert.strictEqual(r.badge, en.badge_all_claimed);
  assert.ok(r.details.some((d) => d === en.detail_pieces.replace("{claimed}", "5").replace("{total}", "5")), "5/5: " + JSON.stringify(r.details));
  assert.ok(!r.details.some((d) => d.includes("4")), "no '4' next to 'done'");

  r = await row({ label: "Rust", claimed: 4, total: 5, allComplete: false, probablyDone: true, expired: false, updatedAt: 1 });
  assert.strictEqual(r.badge, en.badge_probably_done, "probably done - not confirmed: " + r.badge);
  assert.ok(r.details.some((d) => d === en.detail_pieces.replace("{claimed}", "4").replace("{total}", "5")), "the unconfirmed count is shown as it is: " + JSON.stringify(r.details));

  const { I18N, I18N_LANGS } = require("../i18n.js");
  for (const { code } of I18N_LANGS) assert.ok(I18N[code].badge_probably_done, `${code}.badge_probably_done`);
  console.log("  OK  popup: a finished entry shows total/total; 'probably done - not confirmed' (9 languages) for the unconfirmed one");
}

(async () => {
  console.log("Running claim confirmation tests (real content.js + background.js + popup.js, no browser, no network)...\n");
  try {
    await testTheCardParserKeepsEveryTiersNameAndClaimedFlag();
    await testAVanishedCardWithItsLastRewardInClaimedIsConfirmedFiveOfFive();
    await testAVanishedCardWithoutItsLastRewardIsOnlyProbablyDone();
    await testTheTimeoutAcceptsItAsInferredAndAReturningCardCancelsIt();
    await testDuplicateRewardNamesNeedOneClaimedEntryEach();
    await testNothingIsConfirmedWithoutNamesOrAClaimedSection();
    await testPopupShowsTotalOverTotalAndProbablyDone();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
