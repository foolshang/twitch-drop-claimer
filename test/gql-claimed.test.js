/**
 * gql-claimed.test.js
 *
 * Second layer of evidence for "done": the Inventory GQL's dropCampaignsInProgress[].timeBasedDrops[]
 * .self.isClaimed (a field of the real capture; inject.js summarises it as `allClaimed`).
 *
 * The missing-card reconciliation used to skip an entry for as long as the GQL still listed one of its
 * campaigns as ACTIVE - and Twitch keeps a fully claimed campaign ACTIVE until it ends, so with a stale
 * or oddly vanishing card the entry was never confirmed. Now:
 *   - ACTIVE + every tier isClaimed = done (claimed = total), the card gone or still showing 0/1;
 *   - the "still ACTIVE" guard applies only while the GQL shows an unclaimed tier;
 *   - every entry on the same campaign is done together and closes its tab;
 *   - the GQL only ever CONFIRMS done: it never takes it back, the DOM stays the main source.
 *
 * Real background.js; cards parsed by the real content.js on real-structure inventory markup.
 */

const assert = require("assert");
const { realCard, parseCards, world, pinnedEntry, RUST_ID } = require("./campaign-matching.test.js");

const SHARED = { id: "9a1d7e20-0000-4000-8000-00000000c0de", name: "Shared Launcher Campaign", channels: ["aaa", "bbb"] };
const SOLO = { id: "5b2e8f31-0000-4000-8000-00000000beef", name: "Solo Campaign", channels: ["ccc"] };

// what inject.js's Inventory extractor makes of one campaign (with the isClaimed summary)
const sig = (c, { status = "ACTIVE", tiers = 1, tiersClaimed = 0 } = {}) => ({
  id: c.id, name: c.name, status, endAt: Date.parse("2026-10-20T00:00:00Z"), gameId: RUST_ID, gameName: "Rust", channels: c.channels,
  tiers, tiersClaimed, allClaimed: tiers > 0 && tiersClaimed === tiers,
});
const gql = (w, campaigns) => w.bg.send({ type: "gqlDropSignal", operationName: "Inventory", at: 0, signal: { kind: "inventoryCampaigns", operationName: "Inventory", campaigns } }, 1);
const open = (w, slugs) => Object.assign(w.bg.local, {
  watchTabs: Object.fromEntries(slugs.map((s, i) => [s, 11 + i])),
  watchMeta: Object.fromEntries(slugs.map((s, i) => [s, { channel: s.replace("channel:", ""), tabId: 11 + i }])),
});
const REQUIRED = (w) => require("vm").runInContext("REQUIRED_MISSING_SCANS", w.bg.ctx);

async function testActiveWithEveryTierClaimedAndTheCardGoneIsDone() {
  const watchList = [pinnedEntry("ccc")];
  const w = await world({ watchList });
  open(w, ["channel:ccc"]);
  await gql(w, [sig(SOLO, { tiersClaimed: 0 })]);
  await w.scan(parseCards({ cards: [realCard({ campaign: SOLO, percent: 80 })], watchList }));
  const p0 = w.progress("channel:ccc");
  assert.ok(p0.total > 0 && !p0.allComplete, "sanity: seen at 80%");

  // the last tier is claimed; Twitch still sends the campaign as ACTIVE; the card is gone and the Claimed list
  // does not show the reward (a stale / oddly rendered page)
  await gql(w, [sig(SOLO, { tiersClaimed: 1 })]);
  for (let i = 0; i < REQUIRED(w); i++) await w.scan([], []);
  const p = w.progress("channel:ccc");
  assert.strictEqual(p.allComplete, true, "ACTIVE + every tier claimed = done: " + JSON.stringify(p));
  assert.strictEqual(p.claimed, p.total, "claimed = total");
  assert.strictEqual(p.gqlConfirmed, true);
  assert.ok(!w.bg.local.watchTabs["channel:ccc"], "its tab is closed");
  assert.ok(w.bg.logLines().some((l) => /Inventory GQL says every tier of its campaign\(s\) is claimed/.test(l)), "logged");
  console.log("  OK  GQL ACTIVE + every tier isClaimed + card gone = done (claimed = total), tab closed");
}

async function testTwoPinnedEntriesOnTheSameCampaignAreDoneTogetherAndFreeTheirSlots() {
  const watchList = [pinnedEntry("aaa"), pinnedEntry("bbb")];
  const w = await world({ watchList });
  open(w, ["channel:aaa", "channel:bbb"]);
  await gql(w, [sig(SHARED)]);
  await w.scan(parseCards({ cards: [realCard({ campaign: SHARED, percent: 90 })], watchList }));
  assert.ok(w.progress("channel:aaa").total > 0 && w.progress("channel:bbb").total > 0, "sanity: both entries matched the campaign");

  await gql(w, [sig(SHARED, { tiersClaimed: 1 })]);
  for (let i = 0; i < REQUIRED(w); i++) await w.scan([], []);
  assert.deepStrictEqual(["channel:aaa", "channel:bbb"].map((k) => w.progress(k).allComplete), [true, true], "both done together");
  assert.deepStrictEqual(Object.keys(w.bg.local.watchTabs || {}), [], "both tabs closed - the slots are free for other entries");
  console.log("  OK  two pinned entries on the same campaign: both done, both tabs closed");
}

async function testAnUnclaimedTierKeepsTheGuardAndNothingIsDone() {
  const watchList = [pinnedEntry("ccc")];
  const w = await world({ watchList });
  open(w, ["channel:ccc"]);
  await gql(w, [sig(SOLO, { tiers: 2, tiersClaimed: 0 })]);
  await w.scan(parseCards({ cards: [realCard({ campaign: SOLO, percent: 80 })], watchList }));
  await gql(w, [sig(SOLO, { tiers: 2, tiersClaimed: 1 })]); // one tier is still unclaimed
  for (let i = 0; i < REQUIRED(w) + 4; i++) await w.scan([], [[SOLO.name, 1]]);
  const p = w.progress("channel:ccc");
  assert.strictEqual(p.allComplete, false, "an unclaimed tier: the ACTIVE guard holds, not done");
  assert.ok(!p.gqlConfirmed);
  assert.ok(w.bg.local.watchTabs["channel:ccc"], "its tab stays");
  // a GQL that carries no isClaimed information at all (older shape) changes nothing either
  await gql(w, [{ id: SOLO.id, name: SOLO.name, status: "ACTIVE", endAt: null, gameId: RUST_ID, gameName: "Rust", channels: SOLO.channels }]);
  for (let i = 0; i < REQUIRED(w) + 2; i++) await w.scan([], []);
  assert.strictEqual(w.progress("channel:ccc").allComplete, false);
  console.log("  OK  an unclaimed tier (or no isClaimed data): not done, as before");
}

async function testAStaleCardThatStillShowsProgressIsConfirmedByTheGql() {
  const watchList = [pinnedEntry("ccc")];
  const w = await world({ watchList });
  open(w, ["channel:ccc"]);
  const stale = parseCards({ cards: [realCard({ campaign: SOLO, percent: 0 })], watchList }); // the page still says 0%
  await gql(w, [sig(SOLO, { tiersClaimed: 1 })]);
  await w.scan(stale);
  const p = w.progress("channel:ccc");
  assert.strictEqual(p.allComplete, true, "the card is stale (0%) but the GQL says everything is claimed: " + JSON.stringify(p));
  assert.strictEqual(p.claimed, p.total);
  assert.ok(!w.bg.local.watchTabs["channel:ccc"]);

  // never back to not-done: the same stale card again, and even a GQL that no longer lists the campaign
  await w.scan(stale);
  assert.strictEqual(w.progress("channel:ccc").allComplete, true, "a stale card does not undo it");
  await gql(w, []);
  await w.scan(stale);
  assert.strictEqual(w.progress("channel:ccc").allComplete, true, "nor does the GQL losing the campaign");
  console.log("  OK  a stale card showing 0% is confirmed done by the GQL, and stays done");
}

(async () => {
  console.log("Running Inventory GQL isClaimed tests (real background.js + content.js card parsing)...\n");
  try {
    await testActiveWithEveryTierClaimedAndTheCardGoneIsDone();
    await testTwoPinnedEntriesOnTheSameCampaignAreDoneTogetherAndFreeTheirSlots();
    await testAnUnclaimedTierKeepsTheGuardAndNothingIsDone();
    await testAStaleCardThatStillShowsProgressIsConfirmedByTheGql();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
