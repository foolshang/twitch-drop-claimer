/**
 * inventory-parse.test.js
 *
 * Exercises content.js's parseInventoryCampaigns() (and its helpers:
 * findCampaignCardBoundary, extractGameIdFromBoxart, extractTierPercent,
 * extractTierDurationMin) against a real jsdom DOM built from the actual
 * structure of a real, logged-in /drops/inventory page, captured live via
 * a browser console session - not guessed. That capture found:
 *   - no game name text anywhere in a campaign card any more (only in the
 *     unrelated followed/live-channels sidebar) - cards are identified by
 *     a boxart <img data-test-selector="...game-card-image"> whose src
 *     encodes a numeric id, confirmed (for a real Division 2 campaign) to
 *     equal Twitch's own GQL game.id
 *   - each reward tier's own [role="progressbar"] already reports
 *     aria-valuenow/valuemax as a 0-100 percentage
 *   - "N% of X hours"/"N% of X minutes" text sits right next to each tier
 *
 * Uses jsdom (devDependency, test-only - content.js itself has zero
 * runtime dependencies) since this logic is meaningless to test without a
 * real DOM tree/querySelectorAll/closest(). jsdom does not implement
 * innerText (no layout engine) - polyfilled as textContent below, which is
 * an adequate approximation for a controlled fixture with no hidden
 * elements.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// content.js wraps its entire body in a single top-level `(() => { ... })();`
// IIFE (deliberately, to avoid leaking anything into the content-script's
// global scope) so its internal functions - parseInventoryCampaigns and its
// helpers, what this file actually needs to call - aren't reachable via
// vm.runInContext("name", ctx) the way background.js's top-level functions
// are in the other test files. Strip just that one outer wrapper for the
// vm context here so its inner declarations become directly callable;
// content.js itself is never modified, only this string read of it.
function readContentJsUnwrapped() {
  const src = read("content.js");
  const startMarker = "(() => {";
  const endMarker = "})();";
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.lastIndexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error("content.js's IIFE wrapper markers changed - update readContentJsUnwrapped()");
  }
  return src.slice(startIdx + startMarker.length, endIdx);
}

// Mirrors the real structure found live: a boxart <img> a couple of levels
// under a per-campaign boundary div, sharing a parent with sibling cards -
// exactly what findCampaignCardBoundary's "count the images" walk needs.
function cardHtml({ gameId, campaignName, tiers, extraCardText = "" }) {
  const tiersHtml = tiers.map(({ now, max = 100, label, durationText }) => `
    <div class="ScTower-sc-1sjzzes-0 tw-tower">
      <div class="wrap"><div role="progressbar" aria-valuenow="${now}" aria-valuemin="0" aria-valuemax="${max}"></div></div>
      <div>${label}</div>
      <div>${durationText || ""}</div>
    </div>
  `).join("\n");

  return `
    <div class="cardBoundary">
      <div class="imgWrap">
        <img data-test-selector="DropsCampaignInProgressDescription-game-card-image"
             src="https://static-cdn.jtvnw.net/ttv-boxart/${gameId}_IGDB-285x380.jpg">
      </div>
      <div class="campaignInfo">
        <div>${campaignName}</div>
        ${extraCardText}
        ${tiersHtml}
      </div>
    </div>
  `;
}

function makeSandbox(bodyHtml) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  const { window } = dom;
  // jsdom has no layout engine, so innerText isn't implemented - textContent
  // is an adequate stand-in for this fixture (no hidden/collapsed elements)
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; },
    configurable: true,
  });

  const storageData = {};
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    document: window.document,
    location: { pathname: "/drops/inventory", href: "https://www.twitch.tv/drops/inventory" },
    MutationObserver: window.MutationObserver,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
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
      runtime: { sendMessage: () => Promise.resolve() },
    },
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(readContentJsUnwrapped(), ctx);
  return { ctx, window };
}

function callParse(ctx, watchList, gameIdMap) {
  return vm.runInContext("parseInventoryCampaigns", ctx)(watchList, gameIdMap);
}

async function testMatchesByBoxartIdNotText() {
  const html = cardHtml({
    gameId: "1264310518",
    campaignName: "Ignite MSF 2026 Day 3", // NOT "Marvel Rivals" - matches real capture
    tiers: [{ now: 21, label: "MSF26 LA Dawn Nameplate", durationText: "21% of 4 hours" }],
  });
  const { ctx } = makeSandbox(html);
  const watchList = [{ input: "marvel rivals", slug: "marvel-rivals" }];
  const gameIdMap = { "1264310518": "Marvel Rivals" };

  const result = callParse(ctx, watchList, gameIdMap);
  assert.strictEqual(result.length, 1, "must find exactly one matched campaign");
  assert.strictEqual(result[0].slug, "marvel-rivals");
  assert.strictEqual(result[0].label, "Marvel Rivals");

  console.log("  OK  matches a card to a tracked slug via boxart id -> gameIdMap, ignoring the visible campaign-period text");
}

async function testUnknownBoxartIdSkippedNotGuessed() {
  const html = cardHtml({
    gameId: "999999999",
    campaignName: "Some Other Drop",
    tiers: [{ now: 50, label: "Tier", durationText: "50% of 2 hours" }],
  });
  const { ctx } = makeSandbox(html);
  const watchList = [{ input: "marvel rivals", slug: "marvel-rivals" }];

  const result = callParse(ctx, watchList, {}); // gameIdMap doesn't know this id yet
  assert.strictEqual(result.length, 0, "an unlearned boxart id must be skipped, not guessed at");

  console.log("  OK  a boxart id not yet in gameIdMap is skipped (fails closed, self-heals once learned)");
}

async function testPercentAndClaimedFromProgressbar() {
  const html = cardHtml({
    gameId: "1264310518",
    campaignName: "Ignite MSF 2026 Day 3",
    tiers: [
      { now: 21, label: "Tier A", durationText: "21% of 4 hours" },
      { now: 100, label: "Tier B (done)", durationText: "" },
      { now: 43, label: "Tier C", durationText: "43% of 2 hours" },
    ],
  });
  const { ctx } = makeSandbox(html);
  const watchList = [{ input: "marvel rivals", slug: "marvel-rivals" }];
  const gameIdMap = { "1264310518": "Marvel Rivals" };

  const result = callParse(ctx, watchList, gameIdMap);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].total, 3, "must count every progressbar as a tier");
  assert.strictEqual(result[0].claimed, 1, "only the tier at 100% counts as claimed");
  // 4h * (100-21)/100 = 189.6 -> 190, 2h * (100-43)/100 = 68.4 -> 68 (100% tier contributes 0)
  assert.strictEqual(result[0].timeRemainingMin, 190 + 68, "remaining minutes summed from the non-complete tiers' own percent+duration text");

  console.log("  OK  reads percent/claimed directly from aria-valuenow, sums remaining minutes from the nearby duration text");
}

async function testMultipleCardsStayIndependent() {
  const cardA = cardHtml({
    gameId: "1264310518",
    campaignName: "Ignite MSF 2026 Day 3",
    tiers: [{ now: 21, label: "A tier", durationText: "21% of 4 hours" }],
  });
  const cardB = cardHtml({
    gameId: "504463",
    campaignName: "TCTD2 Y8S3 Red Horizon",
    tiers: [
      { now: 27, label: "B tier 1", durationText: "27% of 4 hours" },
      { now: 100, label: "B tier 2", durationText: "" },
    ],
  });
  const { ctx } = makeSandbox(`<div id="wrapper">${cardA}${cardB}</div>`);
  const watchList = [
    { input: "marvel rivals", slug: "marvel-rivals" },
    { input: "the division 2", slug: "tom-clancys-the-division-2" },
  ];
  const gameIdMap = { "1264310518": "Marvel Rivals", "504463": "Tom Clancy's The Division 2" };

  const result = callParse(ctx, watchList, gameIdMap);
  assert.strictEqual(result.length, 2, "both cards must be found and stay separate");
  const bySlug = Object.fromEntries(result.map((r) => [r.slug, r]));
  assert.strictEqual(bySlug["marvel-rivals"].total, 1);
  assert.strictEqual(bySlug["tom-clancys-the-division-2"].total, 2);
  assert.strictEqual(bySlug["tom-clancys-the-division-2"].claimed, 1);

  console.log("  OK  two adjacent campaign cards are correctly separated, tiers never bleed across cards");
}

async function testExpiredAndAccountNotConnectedTextDetection() {
  const html = cardHtml({
    gameId: "1264310518",
    campaignName: "Ignite MSF 2026 Day 2",
    tiers: [{ now: 0, label: "Old tier", durationText: "" }],
    extraCardText: "<div>This reward is no longer available.</div><div>Connect your account</div>",
  });
  const { ctx } = makeSandbox(html);
  const watchList = [{ input: "marvel rivals", slug: "marvel-rivals" }];
  const gameIdMap = { "1264310518": "Marvel Rivals" };

  const result = callParse(ctx, watchList, gameIdMap);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].expired, true);
  assert.strictEqual(result[0].accountNotConnected, true);

  console.log("  OK  expired/accountNotConnected text detection still works against the current card structure");
}

async function testExpiresAtParsedFromEndDateFormat() {
  // real in-progress card text (2026-09-01 RDP capture) reads
  // "End Date: Wed, Aug 26, 7:59 AM GMT+7" - weekday + "<Month> <day>",
  // no "ends on". Use a date ~3 months out so there's no this-year/next-year
  // ambiguity and the assertion stays deterministic.
  const target = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const monthDay = target.toLocaleString("en-US", { month: "short", day: "numeric" });
  const weekday = target.toLocaleString("en-US", { weekday: "short" });

  const html = cardHtml({
    gameId: "1264310518",
    campaignName: "Some Active Campaign",
    tiers: [{ now: 40, label: "Tier", durationText: "40% of 4 hours" }],
    extraCardText: `<div>End Date: ${weekday}, ${monthDay}, 7:59 AM GMT+7</div>`,
  });
  const { ctx } = makeSandbox(html);
  const watchList = [{ input: "marvel rivals", slug: "marvel-rivals" }];
  const gameIdMap = { "1264310518": "Marvel Rivals" };

  const result = callParse(ctx, watchList, gameIdMap);
  assert.strictEqual(result.length, 1);
  assert.ok(result[0].expiresAt != null, '"End Date: <weekday>, <Month> <day>" must be parsed to a timestamp');
  const drift = Math.abs(result[0].expiresAt - new Date(`${monthDay} ${target.getFullYear()}`).getTime());
  assert.ok(drift < 24 * 60 * 60 * 1000, "parsed expiry lands on the right calendar day");
  assert.strictEqual(result[0].expired, false, "a future end date alone is not an 'expired' signal");

  console.log("  OK  expiresAt is parsed from the real 'End Date: <weekday>, <Month> <day>, <time>' card format");
}

async function testSameSlugTwoCampaignsExpiredFirstStaysExpired() {
  // real capture (2026-08-28): marvel-rivals had an old, past-end-date
  // campaign card ("Ignite MSF 2026 Day 1") still showing alongside a
  // current active one on the same inventory page - both share the same
  // boxart id/slug. DOM order here: expired card first, active second.
  const expiredCard = cardHtml({
    gameId: "1264310518",
    campaignName: "Ignite MSF 2026 Day 1",
    tiers: [{ now: 0, label: "Old tier", durationText: "" }],
    extraCardText: "<div>This reward is no longer available.</div>",
  });
  const activeCard = cardHtml({
    gameId: "1264310518",
    campaignName: "Ignite MSF 2026 Day 3",
    tiers: [{ now: 21, label: "Active tier", durationText: "21% of 4 hours" }],
  });
  const { ctx } = makeSandbox(`<div id="wrapper">${expiredCard}${activeCard}</div>`);
  const watchList = [{ input: "marvel rivals", slug: "marvel-rivals" }];
  const gameIdMap = { "1264310518": "Marvel Rivals" };

  const result = callParse(ctx, watchList, gameIdMap);
  assert.strictEqual(result.length, 1, "two same-slug cards must collapse into one result, not one per card");
  assert.strictEqual(result[0].expired, false, "an active card for the same slug must win over an expired one, regardless of DOM order");
  assert.strictEqual(result[0].claimed, 0);
  assert.strictEqual(result[0].total, 1);

  console.log("  OK  a slug with both an expired and an active campaign card only reports the active one (expired-first DOM order)");
}

async function testSameSlugTwoCampaignsActiveFirstStillWins() {
  // same real-world scenario, opposite DOM order - the active card must
  // still win even when the expired one would otherwise overwrite it last
  const activeCard = cardHtml({
    gameId: "1264310518",
    campaignName: "Ignite MSF 2026 Day 3",
    tiers: [{ now: 21, label: "Active tier", durationText: "21% of 4 hours" }],
  });
  const expiredCard = cardHtml({
    gameId: "1264310518",
    campaignName: "Ignite MSF 2026 Day 1",
    tiers: [{ now: 0, label: "Old tier", durationText: "" }],
    extraCardText: "<div>This reward is no longer available.</div>",
  });
  const { ctx } = makeSandbox(`<div id="wrapper">${activeCard}${expiredCard}</div>`);
  const watchList = [{ input: "marvel rivals", slug: "marvel-rivals" }];
  const gameIdMap = { "1264310518": "Marvel Rivals" };

  const result = callParse(ctx, watchList, gameIdMap);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].expired, false, "a still-active campaign must never be silently abandoned because an unrelated expired card for the same game also exists");

  console.log("  OK  a slug with both an active and an expired campaign card only reports the active one (active-first DOM order)");
}

(async () => {
  console.log("Running inventory-parse tests (real jsdom DOM, no real browser/network)...\n");
  try {
    await testMatchesByBoxartIdNotText();
    await testUnknownBoxartIdSkippedNotGuessed();
    await testPercentAndClaimedFromProgressbar();
    await testMultipleCardsStayIndependent();
    await testExpiredAndAccountNotConnectedTextDetection();
    await testExpiresAtParsedFromEndDateFormat();
    await testSameSlugTwoCampaignsExpiredFirstStaysExpired();
    await testSameSlugTwoCampaignsActiveFirstStillWins();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    process.exit(1);
  }
})();
