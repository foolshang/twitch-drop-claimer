/**
 * campaign-matching.test.js
 *
 * "Rust" and "@streamer" (a channel that plays Rust) on one watch list. A game
 * can have several campaigns at once - a general one for everybody and many
 * that only count on named channels - and their inventory cards share the
 * game's boxart. 0.6.16 collapsed all cards of a game into the FIRST one
 * (content.js dedupeBySlugPreferringActive), so a "Rust" entry could show - and
 * finish on - the numbers of a restricted campaign it can never earn by
 * watching any channel, and a pinned entry could not exist next to a game
 * entry at all. Now (shared.js entryOwnsCard / aggregateEntryProgress):
 *   "Rust"      owns the cards of its game that are NOT restricted to channels;
 *   "@streamer" owns the cards of ACTIVE campaigns that name its channel (all
 *               of them must be complete for it to be done);
 *   an entry that owns no card yet has no progress: unknown, never done, and
 *   still watched.
 *
 * Fixtures follow the real structure captured from a logged-in inventory page
 * on 2026-10-01 (card: title link /drops/campaigns?dropID=<id>, end date,
 * boxart, "including /a and /b" channel links, reward tier with progressbar) and
 * the real Inventory GQL shape (dropCampaignsInProgress[]: id, name, status,
 * game, allow.channels). Names/ids/logins are public Twitch data; no user id,
 * user name or cookie appears anywhere (currentUser.id is "1").
 *
 * Real content.js (jsdom DOM) feeds the real background.js (vm sandbox). No
 * browser, no network, no Twitch session.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { makeClock, makeBackground, flush } = require("./claim-harness");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// ---- real-structure fixtures ---------------------------------------------------
const RUST_ID = "263490";
const TAC = { id: "fbd182c6-2414-4355-858b-b61413b994cb", name: "Rust Isles Tac Gloves", channels: ["itsryanhiga", "welyn"] };
const BOONIE = { id: "d251f62f-8e9b-469b-9b97-60064ff411ad", name: "Rust Isles Boonie", channels: ["fuslie", "sven"] };
const FACEMASK = { id: "03b87dc1-4caf-4090-a1d5-85e7b77e34ec", name: "Rust Isles Facemask", channels: ["cyr", "mrwobblestwitch"] };
const GENERAL = { id: "fd08f113-4582-4760-9c8d-20fc5100df18", name: "Rust Isles General Drops", channels: null };

// one inventory card, shaped like the captured real one
function realCard({ campaign, percent = 0, hours = 1, gameId = RUST_ID, expiredText = false }) {
  const channels = campaign.channels || [];
  const hint = channels.length
    ? `<p data-test-selector="DropsCampaignInProgressDescription-hint-text-parent">To continue the progress, go to <a rel="noopener noreferrer" href="/directory/category/rust?filter=drops" target="_blank">a participating live channel</a> including <span><a data-test-selector="DropsCampaignInProgressDescription-two-channels-hint-text" rel="noopener noreferrer" target="_blank" href="https://www.twitch.tv/${channels[0]}">/${channels[0]}</a></span>${
      channels[1] ? ` and <a data-test-selector="DropsCampaignInProgressDescription-multi-channels-hint-text" rel="noopener noreferrer" target="_blank" href="https://www.twitch.tv/${channels[1]}">/${channels[1]}</a>` : ""}</p>`
    : `<p data-test-selector="DropsCampaignInProgressDescription-hint-text-parent">To continue the progress, go to <a rel="noopener noreferrer" href="/directory/category/rust?filter=drops" target="_blank">a participating live channel</a></p>`;
  return `
<div class="card">
  <div>
    <div><p title=""><a href="/drops/campaigns?dropID=${campaign.id}">${campaign.name}</a></p></div>
    <div><p><span>End Date: </span><span>Mon, Oct 5, 6:58 AM GMT+7</span></p></div>
    <div>
      <div><img data-test-selector="DropsCampaignInProgressDescription-game-card-image" alt="Drops Campaign Image" src="https://static-cdn.jtvnw.net/ttv-boxart/${gameId}_IGDB-285x380.jpg"></div>
      <div><div>${hint}</div>
        <a data-test-selector="DropsCampaignInProgressDescription-about-button" rel="noopener noreferrer" target="_blank" href="https://twitch.facepunch.com/"><div><div data-a-target="tw-core-button-label-text">About This Drop</div></div></a>
      </div>
    </div>
  </div>
  <div>
    ${expiredText ? "<div>This reward is no longer available.</div>" : ""}
    <div class="tier">
      <div><div><div><img alt="Reward Image Icon" src="https://static-cdn.jtvnw.net/twitch-quests-assets/REWARD/x.png"></div><div><div><p>${campaign.name}</p></div></div></div></div>
      <div><div role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"></div><div><p><span>${percent}</span>% of ${hours} hour</p></div></div>
    </div>
    <div></div><div></div>
  </div>
</div>`;
}

// the real Claimed section shape (h5 + description, then one block per claimed drop)
function claimedSection(names) {
  const items = names.map((n) => `<div><div><div><p>4 hours ago</p></div><div><div><div>1</div></div></div></div><div><p>${n}</p></div></div>`).join("");
  const empty = names.length === 0 ? `<div><div><svg></svg></div><div><p>There are no items in your inventory yet.</p></div></div>` : "";
  return `<div><div><h5>Claimed</h5></div><div><p>Depending on the number of claims...</p></div>${empty}${items}<button>Load More</button></div><h4>Rewards</h4><div><p>There are no rewards.</p></div>`;
}

// the Inventory GQL's campaign records, real shape (trimmed to what matters)
function gqlCampaign(c, { status = "ACTIVE", gameName = "Rust", gameId = RUST_ID } = {}) {
  return {
    id: c.id, name: c.name, status, endAt: "2026-10-04T23:58:59.999Z", startAt: "2026-09-25T00:00:00Z",
    game: { id: gameId, name: gameName, __typename: "Game" },
    allow: { channels: c.channels ? c.channels.map((l, i) => ({ id: String(1000 + i), name: l, url: `https://www.twitch.tv/${l}`, __typename: "Channel" })) : null, __typename: "DropCampaignACL" },
    self: { isAccountConnected: true, __typename: "DropCampaignSelfEdge" },
    timeBasedDrops: [{ id: "d1", name: c.name, requiredMinutesWatched: 60, self: { currentMinutesWatched: 4, isClaimed: false, dropInstanceID: null } }],
    __typename: "DropCampaign",
  };
}
const inventoryResponse = (campaigns) => ({ data: { currentUser: { id: "1", inventory: { dropCampaignsInProgress: campaigns, __typename: "Inventory" }, __typename: "User" } } });

// ---- content.js parse (jsdom) ------------------------------------------------------
function unwrapIIFE(src) {
  const a = src.indexOf("(() => {");
  const b = src.lastIndexOf("})();");
  return src.slice(a + "(() => {".length, b);
}
function parseCards({ cards, claimed = [], watchList, gameIdMap = { [RUST_ID]: "Rust" } }) {
  const dom = new JSDOM(`<!doctype html><html><body><div class="list">${cards.join("")}</div>${claimedSection(claimed)}</body></html>`);
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; }, configurable: true });
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    document: window.document,
    location: { pathname: "/drops/inventory", href: "https://www.twitch.tv/drops/inventory" },
    MutationObserver: window.MutationObserver,
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    browser: { storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() }, onChanged: { addListener() {} } }, runtime: { sendMessage: () => Promise.resolve() } },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(unwrapIIFE(read("content.js")), ctx);
  const claimedCounts = vm.runInContext("extractClaimedCounts", ctx)();
  const out = vm.runInContext("parseInventoryCampaigns", ctx)(watchList, gameIdMap, claimedCounts);
  return JSON.parse(JSON.stringify(out)); // plain objects, as a message would carry them
}

// ---- the real background + one scan ----------------------------------------------------
const RUST = { input: "Rust", slug: "rust" };
const pinnedEntry = (channel, extra = {}) => ({ input: `@${channel}`, slug: `channel:${channel}`, channel, pinnedChannel: true, ...extra });

async function world({ watchList, local = {} }) {
  const clock = makeClock();
  const bg = await makeBackground({ clock, session: { tdcSessionStarted: 1 }, local: { watchList, gameIdMap: { [RUST_ID]: "Rust" }, ...local } }); // same browser session: boot keeps the tab state
  return {
    bg, clock,
    gql: (campaigns) => bg.send({
      type: "gqlDropSignal", operationName: "Inventory", at: 0,
      signal: { kind: "inventoryCampaigns", operationName: "Inventory", campaigns: campaigns.map(toSignal) },
    }, 1),
    scan: (cards) => bg.send({ type: "inventoryProgress", campaigns: cards }, 1),
    done: (key) => vm.runInContext("isGameDone", bg.ctx)(key, bg.local.campaignProgress || {}, {}),
    progress: (key) => (bg.local.campaignProgress || {})[key],
  };
}
// what inject.js's Inventory extractor makes of a gqlCampaign record
function toSignal(c) {
  return { id: c.id, name: c.name, status: c.status, endAt: Date.parse(c.endAt), gameId: c.game.id, gameName: c.game.name, channels: c.allow.channels ? c.allow.channels.map((x) => x.name) : null };
}

// ======================================================================================
async function testRustRowIgnoresRestrictedCardsAndPinnedGetsItsOwn() {
  // THE bug: restricted card first and complete, the general campaign second at 6%
  const watchList = [RUST, pinnedEntry("itsryanhiga")];
  const cards = parseCards({
    cards: [realCard({ campaign: TAC, percent: 100 }), realCard({ campaign: GENERAL, percent: 6 })],
    claimed: [TAC.name], watchList,
  });
  assert.strictEqual(cards.length, 2, "both cards of the game are reported (0.6.16 collapsed them into the first one)");
  assert.deepStrictEqual(cards.map((c) => c.campaignId), [TAC.id, GENERAL.id]);
  assert.deepStrictEqual(cards[0].channels, ["itsryanhiga", "welyn"], "the card's own channel links are read");
  assert.deepStrictEqual(cards[1].channels, [], "the general campaign names no channel");

  const w = await world({ watchList });
  await w.gql([gqlCampaign(TAC), gqlCampaign(GENERAL)]);
  await w.scan(cards);

  const rust = w.progress("rust");
  assert.ok(rust, "Rust has a reading");
  assert.strictEqual(rust.allComplete, false, "Rust is NOT done: the complete card belongs to a campaign restricted to other channels");
  assert.deepStrictEqual([rust.claimed, rust.total], [0, 1], "its numbers are the general campaign's (6%), not the restricted one's");
  assert.deepStrictEqual([...rust.campaignNames], [GENERAL.name]);
  assert.strictEqual(rust.timeRemainingMin, 56, "6% of 1 hour done -> 56 min left, from the general card only");
  assert.strictEqual(w.done("rust"), false);

  const pinned = w.progress("channel:itsryanhiga");
  assert.ok(pinned, "the pinned entry has its own reading");
  assert.strictEqual(pinned.allComplete, true, "@itsryanhiga finished ITS campaign");
  assert.deepStrictEqual([...pinned.campaignNames], [TAC.name]);
  assert.strictEqual(w.done("channel:itsryanhiga"), true);
  console.log("  OK  Rust (restricted card 100% + general 6%) = 6%, not done; @itsryanhiga gets its own card and is done");
}

async function testPinnedAndGameNumbersAreIndependent() {
  const watchList = [RUST, pinnedEntry("itsryanhiga")];
  const cards = parseCards({
    cards: [realCard({ campaign: GENERAL, percent: 40 }), realCard({ campaign: TAC, percent: 6 })],
    watchList,
  });
  const w = await world({ watchList });
  await w.gql([gqlCampaign(GENERAL), gqlCampaign(TAC)]);
  await w.scan(cards);
  assert.strictEqual(w.progress("rust").timeRemainingMin, 36, "Rust: the general card at 40%");
  assert.strictEqual(w.progress("channel:itsryanhiga").timeRemainingMin, 56, "@itsryanhiga: its own card at 6%");
  assert.ok(!w.done("rust") && !w.done("channel:itsryanhiga"));
  console.log("  OK  each entry shows the numbers of its own campaign (Rust 40%, @itsryanhiga 6%)");
}

async function testFinishingOneDoesNotStopTheOther() {
  const watchList = [RUST, pinnedEntry("itsryanhiga")];
  for (const [label, rustPct, pinnedPct, expectOpen] of [
    ["pinned campaign finished, general not", 6, 100, ["rust"]],
    ["general campaign finished, pinned not", 100, 6, ["channel:itsryanhiga"]],
  ]) {
    const cards = parseCards({
      cards: [realCard({ campaign: GENERAL, percent: rustPct }), realCard({ campaign: TAC, percent: pinnedPct })],
      claimed: [...(rustPct === 100 ? [GENERAL.name] : []), ...(pinnedPct === 100 ? [TAC.name] : [])],
      watchList,
    });
    const w = await world({ watchList });
    // set after boot: with the master switch off the background tears watch tabs down at start
    Object.assign(w.bg.local, { watchTabs: { rust: 11, "channel:itsryanhiga": 12 }, watchMeta: { rust: { channel: "someone", tabId: 11 }, "channel:itsryanhiga": { channel: "itsryanhiga", tabId: 12 } } });
    await w.gql([gqlCampaign(GENERAL), gqlCampaign(TAC)]);
    await w.scan(cards);
    assert.deepStrictEqual(Object.keys(w.bg.local.watchTabs).sort(), expectOpen.sort(), `${label}: only the finished entry's tab is closed`);
  }
  console.log("  OK  finishing one entry closes only its own tab; the other keeps being watched (both directions)");
}

async function testNoCardYetIsUnknownAndStillWatched() {
  // only restricted cards of OTHER channels in the inventory: Rust has no general card yet, @newguy has none either
  const watchList = [RUST, pinnedEntry("newguy")];
  const cards = parseCards({ cards: [realCard({ campaign: TAC, percent: 50 }), realCard({ campaign: BOONIE, percent: 20 })], watchList });
  const w = await world({ watchList });
  await w.gql([gqlCampaign(TAC), gqlCampaign(BOONIE)]);
  await w.scan(cards);
  assert.strictEqual(w.progress("rust"), undefined, "Rust: no general card yet -> no reading (the restricted cards are not lent to it)");
  assert.strictEqual(w.progress("channel:newguy"), undefined, "@newguy: no campaign names it -> no reading");
  assert.strictEqual(w.done("rust"), false, "unknown is never done");
  assert.strictEqual(w.done("channel:newguy"), false);
  const lacks = vm.runInContext("lacksOpenCampaign", w.bg.ctx);
  assert.strictEqual(lacks(watchList[1], null), false, "and a pinned channel is never gated away for lack of a campaign");
  // many scans later (the card only appears once minutes accrue) still nothing invented
  for (let i = 0; i < 5; i++) await w.scan(cards);
  assert.ok(!w.done("rust") && !w.done("channel:newguy"));
  console.log("  OK  an entry without a card yet is unknown, never done, and nothing is borrowed for it");
}

async function testChannelInTwoActiveCampaignsNeedsBoth() {
  const twoOfWelyn = { ...BOONIE, channels: ["welyn", "sven"] }; // welyn is in TAC and in this one
  const watchList = [pinnedEntry("welyn")];
  const gql = [gqlCampaign(TAC), gqlCampaign(twoOfWelyn)];

  // one complete, one at 40% -> not done; the numbers are both campaigns' together
  let cards = parseCards({ cards: [realCard({ campaign: TAC, percent: 100 }), realCard({ campaign: twoOfWelyn, percent: 40 })], claimed: [TAC.name], watchList });
  let w = await world({ watchList });
  await w.gql(gql);
  await w.scan(cards);
  let p = w.progress("channel:welyn");
  assert.strictEqual(p.allComplete, false, "done only when BOTH campaigns are complete");
  assert.deepStrictEqual([p.claimed, p.total], [1, 2]);
  assert.deepStrictEqual([...p.campaignNames].sort(), [TAC.name, twoOfWelyn.name].sort());
  assert.strictEqual(p.timeRemainingMin, 36, "time left: the unfinished campaign's");

  // both complete -> done
  cards = parseCards({ cards: [realCard({ campaign: TAC, percent: 100 }), realCard({ campaign: twoOfWelyn, percent: 100 })], claimed: [TAC.name, twoOfWelyn.name], watchList });
  w = await world({ watchList });
  await w.gql(gql);
  await w.scan(cards);
  assert.strictEqual(w.progress("channel:welyn").allComplete, true);

  // the GQL says the second campaign is in progress but its card was not read: never done on the first alone
  cards = parseCards({ cards: [realCard({ campaign: TAC, percent: 100 })], claimed: [TAC.name], watchList });
  w = await world({ watchList });
  await w.gql(gql);
  await w.scan(cards);
  assert.strictEqual(w.progress("channel:welyn").allComplete, false, "a campaign the GQL lists but no card shows is not assumed complete");
  console.log("  OK  a channel in 2 active campaigns is done only when both are complete (and never on a card that is missing)");
}

async function testExpiredRestrictedCardNeverCounts() {
  const ironmouseExpired = { id: "4185d21c-7dd1-41f8-9e8f-4f52c7b27622", name: "Ironmouse Subathon 2026", channels: ["ironmouse"] };
  const lgBox = { id: "ab849e29-f685-48e2-97c4-2d2be976af01", name: "Rust Isles Lg Box", channels: ["ironmouse"] };
  const watchList = [pinnedEntry("ironmouse")];
  const cards = parseCards({
    cards: [realCard({ campaign: ironmouseExpired, percent: 100, gameId: "999", expiredText: true }), realCard({ campaign: lgBox, percent: 30 })],
    watchList, gameIdMap: { [RUST_ID]: "Rust", 999: "Just Chatting" },
  });
  const w = await world({ watchList });
  await w.gql([gqlCampaign(ironmouseExpired, { status: "EXPIRED", gameName: "Just Chatting", gameId: "999" }), gqlCampaign(lgBox)]);
  await w.scan(cards);
  const p = w.progress("channel:ironmouse");
  assert.deepStrictEqual([...p.campaignNames], [lgBox.name], "only the ACTIVE campaign that names the channel counts");
  assert.strictEqual(p.allComplete, false);
  console.log("  OK  an expired campaign naming the channel is ignored (only active ones count)");
}

async function testCardsAreClassifiedFromTheirOwnLinksBeforeTheGqlArrives() {
  // the DOM scan can be here before the Inventory GQL: the card's own channel links classify it,
  // and a snapshot arriving afterwards re-judges the scan already received
  const watchList = [RUST, pinnedEntry("itsryanhiga")];
  const cards = parseCards({ cards: [realCard({ campaign: TAC, percent: 100 }), realCard({ campaign: GENERAL, percent: 6 })], claimed: [TAC.name], watchList });
  const w = await world({ watchList });
  await w.scan(cards); // no GQL yet
  assert.strictEqual(w.progress("rust").allComplete, false, "Rust is already not lent the restricted card");
  assert.strictEqual(w.progress("channel:itsryanhiga").allComplete, true);
  const before = w.progress("rust").updatedAt;
  w.clock.advanceTo(w.clock.now + 1000); // the background's clock is the fake one
  await w.gql([gqlCampaign(TAC), gqlCampaign(GENERAL)]);
  assert.ok(w.progress("rust").updatedAt > before, "the late snapshot re-judged the scan");
  assert.deepStrictEqual([...w.progress("rust").campaignIds], [GENERAL.id]);
  console.log("  OK  cards are classified from their own links until the GQL snapshot arrives, which then re-judges the scan");
}

async function testMissingCardIsNotDoneWhileTheGqlStillListsTheCampaign() {
  const watchList = [pinnedEntry("itsryanhiga")];
  const withCard = parseCards({ cards: [realCard({ campaign: TAC, percent: 50 })], watchList });
  const w = await world({ watchList });
  await w.gql([gqlCampaign(TAC)]);
  await w.scan(withCard);
  assert.ok(w.progress("channel:itsryanhiga").total > 0);

  // the card cannot be read for a while, yet the GQL still lists the campaign: not claimed
  for (let i = 0; i < 6; i++) await w.scan([]);
  assert.strictEqual(w.progress("channel:itsryanhiga").allComplete, false, "a vanished card is not 'claimed' while the GQL says the campaign is in progress");

  // the campaign really left In Progress (everything claimed): after the usual corroboration it is done
  await w.gql([]);
  const REQUIRED = vm.runInContext("REQUIRED_MISSING_SCANS", w.bg.ctx);
  for (let i = 0; i < REQUIRED; i++) await w.scan([]);
  assert.strictEqual(w.progress("channel:itsryanhiga").allComplete, true);
  console.log("  OK  a vanished card means claimed only once the Inventory GQL no longer lists the campaign");
}

async function testDirectoryPickAvoidsChannelsOtherEntriesWatch() {
  const watchList = [RUST, pinnedEntry("itsryanhiga")];
  const w = await world({ watchList });
  Object.assign(w.bg.local, {
    enabled: true, autoWatchEnabled: true, watchTabs: { rust: 5, "channel:itsryanhiga": 6 },
    watchMeta: { "channel:itsryanhiga": { channel: "itsryanhiga", tabId: 6 } },
  });
  const info = await w.bg.send({ type: "isWatchTab" }, 5);
  assert.ok(info.isWatchTab);
  assert.ok([...info.blockedChannels].includes("itsryanhiga"), "Rust's directory pick must not land on the channel @itsryanhiga already watches");
  const pinnedInfo = await w.bg.send({ type: "isWatchTab" }, 6);
  assert.ok(![...pinnedInfo.blockedChannels].includes("itsryanhiga"), "the pinned entry itself is not blocked from its own channel");
  console.log("  OK  a game entry's directory pick avoids the channel a pinned entry is watching");
}

// ---- shared.js rules, on their own ---------------------------------------------------------
function testOwnershipRules() {
  const ctx = vm.createContext({});
  vm.runInContext(read("shared.js"), ctx);
  const owns = vm.runInContext("entryOwnsCard", ctx);
  const rust = { slug: "rust" };
  const pin = (channel, extra) => ({ slug: `channel:${channel}`, channel, pinnedChannel: true, ...extra });
  const card = (o) => ({ slug: "rust", campaignId: "x", channels: [], expired: false, ...o });
  const meta = (o) => ({ id: "x", status: "ACTIVE", gameId: RUST_ID, gameName: "Rust", channels: null, ...o });

  assert.ok(owns(rust, card({})), "general card -> game entry");
  assert.ok(!owns(rust, card({ channels: ["a"] })), "restricted card (own links) -> not the game entry");
  assert.ok(!owns(rust, card({ channels: [] }), { metaById: { x: meta({ channels: ["a"] }) } }), "the GQL record wins: restricted there although the card shows no links");
  assert.ok(owns(rust, card({ channels: ["a"] }), { metaById: { x: meta({ channels: null }) } }), "and general there although the card showed a link");
  assert.ok(!owns(rust, { slug: null, campaignId: null, channels: [] }), "a card whose game is unknown is lent to nobody");

  assert.ok(owns(pin("a"), card({ channels: ["a", "b"] })), "pinned: channel in the card's list");
  assert.ok(owns(pin("A"), card({ channels: ["a"] })), "case-insensitive");
  assert.ok(!owns(pin("c"), card({ channels: ["a", "b"] })), "pinned: channel not named");
  assert.ok(!owns(pin("a"), card({ channels: [] })), "pinned: never the general campaign");
  assert.ok(owns(pin("c"), card({ channels: ["a"] }), { metaById: { x: meta({ channels: ["a", "b", "c"] }) } }), "the complete list from the GQL beats the card's partial one");
  assert.ok(!owns(pin("a"), card({ channels: ["a"] }), { metaById: { x: meta({ channels: ["a"], status: "EXPIRED" }) } }), "expired -> not counted");
  assert.ok(owns(pin("a", { gameSlug: "diablo-iv" }), card({ channels: ["a"] })), "pinned: the game the channel streams NOW does not decide which campaigns are its (0.6.17 dropped them while it played another game)");
  assert.ok(owns(pin("a", { gameSlug: "rust" }), card({ channels: ["a"] })), "pinned: same game");
  assert.ok(owns(pin("a", { gameSlug: "diablo-iv" }), { slug: null, campaignId: null, channels: ["a"] }), "pinned: unknown game on the card does not block it");
  assert.ok(owns(pin("a", { slug: "rust" }), card({ channels: ["a"] })), "legacy pinned entry (key rewritten to the game slug by 0.6.16) still matches by channel");
  console.log("  OK  ownership rules: general vs restricted, GQL beats the card, expired, game filter, case, legacy keys");
}


// ---- popup rows (real popup.html + popup.js in jsdom) -----------------------------------------
async function renderPopupRows(storage) {
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
    storage: {
      local: { get: (k) => Promise.resolve(pick(k)), set: (o) => { Object.assign(data, o); return Promise.resolve(); } },
      session: { get: () => Promise.resolve({}) },
      onChanged: { addListener() {} },
    },
    runtime: { sendMessage: () => Promise.resolve({}), getManifest: () => ({ version: "0.0.0-test" }) },
    tabs: { query: () => Promise.resolve([]), create() {} },
  };
  Object.defineProperty(w.navigator, "language", { value: "en-US" });
  w.eval([read("i18n.js"), read("shared.js"), read("popup.js")].join("\n"));
  await new Promise((r) => setTimeout(r, 60));
  return [...w.document.querySelectorAll("#gameStatusList .game-status-row")].map((row) => ({
    name: (row.querySelector(".g-name span") || {}).textContent || "",
    badge: (row.querySelector(".g-badge") || {}).textContent || "",
    details: [...row.querySelectorAll(".g-detail")].map((d) => d.textContent),
  }));
}

async function testPopupShowsPinnedRowsLikeGameRows() {
  const en = require("../i18n.js").I18N.en;
  const watchList = [RUST, pinnedEntry("itsryanhiga", { gameSlug: "rust", pinnedGameName: "Rust" }), pinnedEntry("newguy", { gameSlug: "rust", pinnedGameName: "Rust" })];
  const base = { watchList, watchTabs: { rust: 1, "channel:itsryanhiga": 2, "channel:newguy": 3 } };

  // a finished pinned campaign next to a game entry that is still going
  let rows = await renderPopupRows({
    ...base,
    campaignProgress: {
      rust: { label: "Rust", claimed: 0, total: 1, allComplete: false, expired: false, timeRemainingMin: 56, campaignNames: [GENERAL.name], updatedAt: 1 },
      "channel:itsryanhiga": { label: "Rust", claimed: 1, total: 1, allComplete: true, expired: false, timeRemainingMin: 0, campaignNames: [TAC.name], updatedAt: 1 },
    },
  });
  assert.strictEqual(rows.length, 3);
  assert.ok(/^1\. Rust$/.test(rows[0].name), "game row as before: " + rows[0].name);
  assert.ok(/^2\. @itsryanhiga \(Rust\)$/.test(rows[1].name), "pinned row: channel + game in brackets, as before: " + rows[1].name);
  assert.strictEqual(rows[1].badge, en.badge_all_claimed, "a finished pinned campaign shows the same done state as a finished game");
  assert.ok(rows[1].details.some((d) => d === en.row_campaign.replace("{name}", TAC.name)), "and says which campaign: " + JSON.stringify(rows[1].details));
  assert.ok(rows[1].details.some((d) => /1\/1/.test(d) || d.includes(en.detail_pieces.replace("{claimed}", "1").replace("{total}", "1"))), "with its progress: " + JSON.stringify(rows[1].details));
  assert.notStrictEqual(rows[0].badge, en.badge_all_claimed, "the Rust row is not done");
  assert.ok(rows[0].details.some((d) => d.includes("56")), "Rust shows its own time left: " + JSON.stringify(rows[0].details));

  // a pinned channel in progress shows progress and expiry like a game row
  rows = await renderPopupRows({
    ...base,
    campaignProgress: {
      "channel:itsryanhiga": { label: "Rust", claimed: 0, total: 1, allComplete: false, expired: false, timeRemainingMin: 56, expiresAt: Date.parse("2026-10-04T23:58:59Z"), campaignNames: [TAC.name], updatedAt: 1 },
    },
  });
  assert.ok(rows[1].details.some((d) => d.includes("56")), "time left: " + JSON.stringify(rows[1].details));
  assert.ok(rows[1].details.some((d) => d.includes(TAC.name)));

  // no card yet: unknown, and the row still says it is being watched
  assert.ok(rows[2].details.some((d) => d === en.detail_pinned_unknown), "unknown progress is said plainly: " + JSON.stringify(rows[2].details));
  assert.strictEqual(rows[2].badge, en.badge_watching, "and the entry is still watched");
  assert.ok(!rows[2].details.some((d) => d === en.detail_tracking), "not the generic 'tracking' text");
  console.log("  OK  popup: pinned rows show campaign name, progress, time left and done state like game rows; unknown says so and is still watched");
}

// ---- inject.js: the Inventory GQL -> `inventoryCampaigns` signal ---------------------------------
function injectInventory(responseBody) {
  const posted = [];
  const nativeFetch = () => Promise.resolve({ clone: () => ({ text: () => Promise.resolve(JSON.stringify([responseBody])) }) });
  const win = { fetch: nativeFetch, postMessage: (m) => posted.push(m), location: { href: "https://www.twitch.tv/drops/inventory", origin: "https://www.twitch.tv" } };
  const sandbox = { console: { log() {}, warn() {}, error() {} }, Date, JSON, Math, Set, Map, Promise, RegExp, Object, Array, String, Number, window: win, XMLHttpRequest: function XMLHttpRequest() {} };
  sandbox.XMLHttpRequest.prototype = { open() {}, send() {}, addEventListener() {} };
  vm.runInContext(read("inject.js"), vm.createContext(sandbox));
  return win.fetch("https://gql.twitch.tv/gql", { method: "POST", body: JSON.stringify([{ operationName: "Inventory", variables: { fetchRewardCampaigns: true } }]) })
    .then(() => flush()).then(() => JSON.parse(JSON.stringify(posted.map((m) => m.payload.signal))));
}

async function testInventoryExtractorReadsCampaignsAndAllowLists() {
  const signals = await injectInventory(inventoryResponse([
    gqlCampaign(TAC), gqlCampaign(GENERAL), gqlCampaign({ id: "e1", name: "Old", channels: [] }, { status: "EXPIRED", gameName: "Warframe", gameId: "66170" }),
  ]));
  const camp = signals.find((s) => s.kind === "inventoryCampaigns");
  assert.ok(camp, "the Inventory response yields an inventoryCampaigns signal");
  assert.deepStrictEqual(camp.campaigns.map((c) => c.id), [TAC.id, GENERAL.id, "e1"]);
  assert.deepStrictEqual(camp.campaigns[0], { id: TAC.id, name: TAC.name, status: "ACTIVE", endAt: Date.parse("2026-10-04T23:58:59.999Z"), gameId: RUST_ID, gameName: "Rust", channels: ["itsryanhiga", "welyn"] });
  assert.strictEqual(camp.campaigns[1].channels, null, "allow.channels null -> not restricted");
  assert.strictEqual(camp.campaigns[2].channels, null, "an empty list is not restricted either");
  assert.strictEqual(camp.campaigns[2].status, "EXPIRED");
  assert.ok(signals.some((s) => s.kind === "gameIds"), "the old gameIds signal is still sent");
  // an empty inventory is a (meaningful) empty snapshot; a malformed one sends nothing
  const none = await injectInventory(inventoryResponse([]));
  assert.deepStrictEqual(none.filter((s) => s.kind === "inventoryCampaigns").map((s) => s.campaigns.length), [0]);
  const bad = await injectInventory({ data: { currentUser: null } });
  assert.ok(!bad.some((s) => s.kind === "inventoryCampaigns"));
  console.log("  OK  inject.js: the Inventory GQL's campaigns (id, name, status, game, allow.channels) become an inventoryCampaigns snapshot");
}

async function testSavingTheListKeepsWhatWasLearnedAboutPinnedChannels() {
  const dom = new JSDOM(read("popup.html").replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, ""), { runScripts: "outside-only", url: "moz-extension://test/popup.html" });
  const w = dom.window;
  const data = {
    enabled: true, autoWatchEnabled: false, watchListRaw: "Rust\n@streamer",
    watchList: [RUST, pinnedEntry("streamer", { gameSlug: "rust", pinnedGameName: "Rust" })],
  };
  const pick = (k) => (k == null ? { ...data } : typeof k === "string" ? { [k]: data[k] } : Object.fromEntries(k.map((x) => [x, data[x]])));
  w.browser = {
    storage: { local: { get: (k) => Promise.resolve(pick(k)), set: (o) => { Object.assign(data, o); return Promise.resolve(); } }, session: { get: () => Promise.resolve({}) }, onChanged: { addListener() {} } },
    runtime: { sendMessage: () => Promise.resolve({}) }, tabs: { query: () => Promise.resolve([]), create() {} },
  };
  Object.defineProperty(w.navigator, "language", { value: "en-US" });
  w.eval([read("i18n.js"), read("shared.js"), read("popup.js")].join("\n"));
  await new Promise((r) => setTimeout(r, 60));
  w.document.getElementById("gamesList").value = "Rust\n@streamer\n@another";
  w.document.getElementById("save").click();
  await new Promise((r) => setTimeout(r, 60));
  const saved = data.watchList.find((g) => g.channel === "streamer");
  assert.strictEqual(saved.slug, "channel:streamer");
  assert.strictEqual(saved.gameSlug, "rust", "the game the channel was seen playing survives a save");
  assert.strictEqual(saved.pinnedGameName, "Rust");
  assert.ok(!data.watchList.find((g) => g.channel === "another").gameSlug, "a new pinned channel starts unknown");
  console.log("  OK  popup: saving the list keeps the game already learned for a pinned channel that stays on it");
}

// ---- 0.6.18: matched to a campaign, but streaming another game ----------------------------------
function testEntryPlaysWrongGameRules() {
  const ctx = vm.createContext({});
  vm.runInContext(read("shared.js"), ctx);
  const wrong = vm.runInContext("entryPlaysWrongGame", ctx);
  const pin = (extra) => ({ slug: "channel:mrwobblestwitch", channel: "mrwobblestwitch", pinnedChannel: true, gameSlug: "im-only-sleeping", pinnedGameName: "I'm Only Sleeping", ...extra });
  const prog = (extra) => ({ allComplete: false, expired: false, campaignGameSlugs: ["rust"], campaignGameNames: ["rust"], ...extra });

  assert.strictEqual(wrong(pin(), prog()), true, "matched to a Rust campaign, streaming I'm Only Sleeping");
  assert.strictEqual(wrong(pin({ gameSlug: "rust", pinnedGameName: "Rust" }), prog()), false, "streaming the campaign's game");
  assert.strictEqual(wrong(pin(), undefined), false, "not matched to any campaign yet: watches whatever it plays");
  assert.strictEqual(wrong(pin(), prog({ campaignGameSlugs: [] })), false, "campaign game unknown: not judged");
  assert.strictEqual(wrong(pin({ gameSlug: null, pinnedGameName: null }), prog()), false, "channel's game unknown: not judged");
  assert.strictEqual(wrong(pin(), prog({ allComplete: true })), false, "a finished entry is done, not 'wrong game'");
  assert.strictEqual(wrong(pin(), prog({ expired: true })), false);
  assert.strictEqual(wrong({ slug: "rust" }, prog()), false, "a game entry is never 'on another game'");
  assert.strictEqual(wrong(pin({ gameSlug: "tom-clancys-rainbow-six-siege", pinnedGameName: "Rainbow Six Siege" }), prog({ campaignGameSlugs: ["rainbow-six-siege"], campaignGameNames: ["rainbowsixsiege"] })), false,
    "a renamed game (slug differs, name is the same) is not mistaken for another game");
  assert.strictEqual(wrong(pin(), prog({ campaignGameSlugs: ["rust", "im-only-sleeping"] })), false, "any of the campaigns still to earn is for the current game");
  console.log("  OK  entryPlaysWrongGame: only a pinned entry matched to a campaign of another game than the channel streams");
}

async function testMatchingFollowsTheChannelNotTheGameItPlaysNow() {
  // 0.6.17 only matched a campaign while the channel played its game; once the channel switched, a stale
  // reading stayed in the row. Now the campaign is the channel's, whatever it streams.
  const watchList = [pinnedEntry("mrwobblestwitch", { gameSlug: "im-only-sleeping", pinnedGameName: "I'm Only Sleeping" })];
  const cards = parseCards({ cards: [realCard({ campaign: FACEMASK, percent: 40 })], watchList });
  const w = await world({ watchList });
  await w.gql([gqlCampaign(FACEMASK)]);
  await w.scan(cards);
  const p = w.progress("channel:mrwobblestwitch");
  assert.ok(p, "matched to its campaign although the channel streams another game");
  assert.deepStrictEqual([...p.campaignNames], [FACEMASK.name]);
  assert.deepStrictEqual([...p.campaignGameSlugs], ["rust"], "with the game that campaign is for");
  assert.strictEqual(vm.runInContext("entryPlaysWrongGame", w.bg.ctx)(watchList[0], p), true);
  console.log("  OK  a pinned channel stays matched to its campaign (and knows its game) while it streams something else");
}

async function testPopupSaysPlayingAnotherGame() {
  const en = require("../i18n.js").I18N.en;
  const progress = { "channel:mrwobblestwitch": { label: "Rust", claimed: 0, total: 1, allComplete: false, expired: false, timeRemainingMin: 36, campaignNames: [FACEMASK.name], campaignGameSlugs: ["rust"], campaignGameNames: ["rust"], updatedAt: 1 } };
  const base = (extra) => ({ watchList: [pinnedEntry("mrwobblestwitch", extra)], watchTabs: { "channel:mrwobblestwitch": 7 }, campaignProgress: progress });

  let rows = await renderPopupRows(base({ gameSlug: "im-only-sleeping", pinnedGameName: "I'm Only Sleeping" }));
  assert.strictEqual(rows[0].badge, en.badge_other_game, "not 'watching': " + rows[0].badge);
  assert.ok(/mrwobblestwitch \(I'm Only Sleeping\)/.test(rows[0].name), "the game it plays stays in brackets: " + rows[0].name);
  assert.ok(rows[0].details.some((d) => d.includes(FACEMASK.name)), "and the campaign it is matched to");

  rows = await renderPopupRows(base({ gameSlug: "rust", pinnedGameName: "Rust" }));
  assert.strictEqual(rows[0].badge, en.badge_watching, "back on Rust: watching");

  rows = await renderPopupRows({ watchList: [pinnedEntry("mrwobblestwitch", { gameSlug: "im-only-sleeping", pinnedGameName: "I'm Only Sleeping" })], watchTabs: { "channel:mrwobblestwitch": 7 } });
  assert.strictEqual(rows[0].badge, en.badge_watching, "not matched to a campaign yet: watching whatever it plays");

  for (const { code } of require("../i18n.js").I18N_LANGS) assert.ok(require("../i18n.js").I18N[code].badge_other_game, `${code}.badge_other_game`);
  console.log("  OK  popup: 'playing another game - not earning drops' instead of 'watching' (9 languages); watching again on the right game");
}

module.exports = { realCard, claimedSection, gqlCampaign, inventoryResponse, parseCards, TAC, BOONIE, FACEMASK, GENERAL, RUST_ID };

if (require.main === module) (async () => {
  console.log("Running campaign matching tests (real content.js + background.js, no browser, no network)...\n");
  try {
    testOwnershipRules();
    await testRustRowIgnoresRestrictedCardsAndPinnedGetsItsOwn();
    await testPinnedAndGameNumbersAreIndependent();
    await testFinishingOneDoesNotStopTheOther();
    await testNoCardYetIsUnknownAndStillWatched();
    await testChannelInTwoActiveCampaignsNeedsBoth();
    await testExpiredRestrictedCardNeverCounts();
    await testCardsAreClassifiedFromTheirOwnLinksBeforeTheGqlArrives();
    await testMissingCardIsNotDoneWhileTheGqlStillListsTheCampaign();
    await testDirectoryPickAvoidsChannelsOtherEntriesWatch();
    await testPopupShowsPinnedRowsLikeGameRows();
    await testSavingTheListKeepsWhatWasLearnedAboutPinnedChannels();
    await testInventoryExtractorReadsCampaignsAndAllowLists();
    testEntryPlaysWrongGameRules();
    await testMatchingFollowsTheChannelNotTheGameItPlaysNow();
    await testPopupSaysPlayingAnotherGame();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
