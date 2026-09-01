/**
 * open-campaigns.test.js
 *
 * Covers the "does this game have an open drop campaign right now" feature:
 *
 *   - inject.js's ViewerDropsDashboard extractor, against a body shaped
 *     exactly like a real /drops/campaigns GQL response captured live over
 *     RDP on 2026-09-01 (data.currentUser.dropCampaigns[], each with
 *     game.id/displayName, status ACTIVE|EXPIRED, endAt, self.isAccountConnected)
 *   - shared.js's matchOpenCampaign(): resolving a user's typed game name to
 *     the campaign entry it means, without ever binding the wrong game
 *
 * inject.js is a bare `(() => { ... })();` IIFE (page/MAIN world, no
 * browser.* APIs) - the same unwrap trick inventory-parse.test.js uses for
 * content.js exposes its internal EXTRACTORS map to the vm context.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function unwrapIIFE(src, label) {
  const start = src.indexOf("(() => {");
  const end = src.lastIndexOf("})();");
  if (start === -1 || end === -1) throw new Error(`${label}: IIFE wrapper markers changed`);
  return src.slice(start + "(() => {".length, end);
}

function injectCtx() {
  const posted = [];
  const xhrProto = { open() {}, send() {}, addEventListener() {}, setRequestHeader() {} };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date, JSON, Math, Set, Map, Promise, RegExp, Object, Array, String, Number,
    performance: { now: () => 0 },
    location: { href: "https://www.twitch.tv/drops/campaigns" },
    document: { readyState: "complete", visibilityState: "visible", hidden: false },
    window: {
      fetch: () => Promise.resolve(),
      postMessage: (m) => posted.push(m),
      location: { href: "https://www.twitch.tv/drops/campaigns", origin: "https://www.twitch.tv" },
    },
    XMLHttpRequest: function XMLHttpRequest() {},
  };
  sandbox.XMLHttpRequest.prototype = xhrProto;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(unwrapIIFE(read("inject.js"), "inject.js"), ctx);
  return { ctx, posted };
}

// shaped exactly like the real ViewerDropsDashboard response
function dashboardBody(campaigns) {
  return { data: { currentUser: { id: "1", login: "u", dropCampaigns: campaigns } } };
}
function campaign({ gameId, name, status = "ACTIVE", endAt, connected = false }) {
  return {
    id: `c-${gameId}-${status}`,
    name: `${name} drops`,
    game: { id: gameId, displayName: name, boxArtURL: "x", __typename: "Game" },
    status,
    startAt: "2026-08-01T00:00:00Z",
    endAt,
    self: { isAccountConnected: connected, __typename: "DropCampaignSelfEdge" },
    __typename: "DropCampaign",
  };
}

const FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

function testExtractorShape() {
  const { ctx } = injectCtx();
  const extract = vm.runInContext("EXTRACTORS.ViewerDropsDashboard", ctx);

  const body = dashboardBody([
    campaign({ gameId: "504463", name: "Tom Clancy's The Division 2", endAt: FUTURE, connected: true }),
    campaign({ gameId: "1264310518", name: "Marvel Rivals", endAt: FUTURE, connected: false }),
    campaign({ gameId: "504651", name: "MARVEL Strike Force", status: "EXPIRED", endAt: PAST }),
    campaign({ gameId: "504651", name: "MARVEL Strike Force", status: "ACTIVE", endAt: FUTURE }),
  ]);
  const signal = extract(body);

  assert.strictEqual(signal.kind, "openCampaigns");
  assert.strictEqual(signal.snapshot, true);
  assert.strictEqual(signal.games.length, 4);

  const div2 = signal.games.find((g) => g.id === "504463");
  assert.strictEqual(div2.name, "Tom Clancy's The Division 2");
  assert.strictEqual(div2.active, true);
  assert.strictEqual(div2.accountConnected, true);
  assert.strictEqual(typeof div2.endAt, "number");

  const expiredMsf = signal.games.find((g) => g.id === "504651" && !g.active);
  assert.ok(expiredMsf, "the EXPIRED MARVEL Strike Force campaign is still reported (active:false)");

  console.log("  OK  ViewerDropsDashboard extractor -> {kind:openCampaigns, snapshot, games[]} with active/endAt/accountConnected");
}

function testExtractorRejectsWrongShapes() {
  const { ctx } = injectCtx();
  const extract = vm.runInContext("EXTRACTORS.ViewerDropsDashboard", ctx);
  assert.strictEqual(extract({}), null);
  assert.strictEqual(extract({ data: { currentUser: null } }), null);
  assert.strictEqual(extract(dashboardBody([])), null, "no campaigns -> null, not an empty signal");
  assert.strictEqual(extract(dashboardBody([{ id: "x", status: "ACTIVE" }])), null, "campaign with no game -> skipped -> null");
  console.log("  OK  ViewerDropsDashboard extractor returns null for missing / empty / malformed bodies");
}

function testExtractorActiveNeedsFutureEnd() {
  const { ctx } = injectCtx();
  const extract = vm.runInContext("EXTRACTORS.ViewerDropsDashboard", ctx);
  const signal = extract(dashboardBody([
    campaign({ gameId: "1", name: "Past Status Active", status: "ACTIVE", endAt: PAST }),
  ]));
  assert.strictEqual(signal.games[0].active, false,
    "status ACTIVE but endAt already passed -> not actually active");
  console.log("  OK  a campaign whose endAt has passed is not counted active even if status still says ACTIVE");
}

function testSideNavExtractorLearnsSlugs() {
  const { ctx } = injectCtx();
  const extract = vm.runInContext("EXTRACTORS.SideNav", ctx);

  // shaped like the real SideNav response: game objects nested a few levels
  // down, __typename:"Game" with id + slug + displayName
  const body = { data: { sideNav: { sections: { edges: [
    { node: { content: { edges: [
      { node: { __typename: "Stream", id: "s1", game: {
        __typename: "Game", id: "460318", slug: "tom-clancys-rainbow-six-siege", displayName: "Rainbow Six Siege", name: "Rainbow Six Siege",
      } } },
      { node: { __typename: "User", id: "u1", login: "someone" } },
      { node: { __typename: "Stream", id: "s2", game: {
        __typename: "Game", id: "1702520304", slug: "path-of-exile-2", displayName: "Path of Exile 2",
      } } },
    ] } } },
  ] } } } };

  const signal = extract(body);
  assert.strictEqual(signal.kind, "gameSlugs");
  assert.strictEqual(signal.games.length, 2, "two distinct games, the User node ignored");
  const r6 = signal.games.find((g) => g.id === "460318");
  assert.strictEqual(r6.slug, "tom-clancys-rainbow-six-siege",
    "learns the real legacy category slug, not toSlug('Rainbow Six Siege')");
  assert.strictEqual(r6.name, "Rainbow Six Siege");
  assert.strictEqual(extract({ data: {} }), null);

  console.log("  OK  SideNav extractor collects id->slug for renamed games (Rainbow Six Siege keeps tom-clancys- slug)");
}

function sharedCtx() {
  const ctx = vm.createContext({ console });
  vm.runInContext(read("shared.js"), ctx);
  return ctx;
}

function testMatchOpenCampaign() {
  const ctx = sharedCtx();
  const match = vm.runInContext("matchOpenCampaign", ctx);

  const campaigns = [
    { slug: "marvel-rivals", displayName: "Marvel Rivals", gameId: "1264310518", active: true },
    { slug: "tom-clancys-the-division-2", displayName: "Tom Clancy's The Division 2", gameId: "504463", active: true },
    { slug: "marvel-strike-force", displayName: "MARVEL Strike Force", gameId: "504651", active: true },
    { slug: "world-of-warcraft", displayName: "World of Warcraft", gameId: "27546", active: true },
  ];

  // 1. slug / alias
  assert.strictEqual(match("wow", campaigns).slug, "world-of-warcraft", "alias 'wow' resolves via toSlug");
  assert.strictEqual(match("Marvel Rivals", campaigns).slug, "marvel-rivals", "exact-ish name -> slug match");

  // 2. exact normalized name, punctuation/case ignored
  assert.strictEqual(
    match("tom clancys the division 2", campaigns).slug,
    "tom-clancys-the-division-2"
  );
  assert.strictEqual(match("MARVEL   STRIKE   FORCE", campaigns).slug, "marvel-strike-force");

  // 3. loose containment, but only when exactly one campaign matches
  assert.strictEqual(match("division 2", campaigns).slug, "tom-clancys-the-division-2",
    "'division 2' is contained in exactly one campaign name");

  // never bind the wrong game
  assert.strictEqual(match("marvel", campaigns), null,
    "'marvel' is contained in TWO campaign names -> ambiguous -> no match, not a guess");
  assert.strictEqual(match("path of exile 2", campaigns), null, "a game with no open campaign -> null");
  assert.strictEqual(match("", campaigns), null);
  assert.strictEqual(match("wow", []), null);

  console.log("  OK  matchOpenCampaign resolves by slug/alias, normalized name, and unambiguous containment - never a wrong bind");
}

(async () => {
  console.log("Running open-campaigns tests (real inject.js extractor + shared.js matcher)...\n");
  try {
    testExtractorShape();
    testExtractorRejectsWrongShapes();
    testExtractorActiveNeedsFutureEnd();
    testSideNavExtractorLearnsSlugs();
    testMatchOpenCampaign();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.message, "\n", e.stack);
    process.exit(1);
  }
})();
