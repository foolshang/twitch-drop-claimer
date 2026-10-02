/**
 * auto-watch-multi-tab.test.js
 *
 * Loads the real background.js into a sandboxed vm context with a working
 * in-memory tabs registry (not just call counters), then exercises the
 * multi-tab scheduler directly: quota filling, independent per-game
 * completion, all-done teardown, and the "every tab call passes
 * active:false, never active:true or windows.update(focused:true)" audit.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function makeSandbox() {
  const storageData = {
    enabled: true, autoWatchEnabled: true, tabQuota: 2,
    // a fresh but empty open-campaign snapshot: recent enough that
    // background.js won't open a transient /drops/campaigns tab to refresh
    // it, empty enough that lacksOpenCampaign() treats it as "no usable
    // data" and never skips a game on it (see its guard). Tests that
    // exercise the campaign-check path set their own populated snapshot.
    openCampaigns: { fetchedAt: Date.now(), bySlug: {} },
  };
  const changeListeners = [];
  const alarmListeners = [];
  const liveAlarms = new Set();

  const tabsById = new Map(); // id -> { url, active, pinned, muted }
  let nextTabId = 1;
  let violations = []; // any tabs call missing/violating active:false

  function auditTabCall(opts) {
    if (opts.active !== false) violations.push(`active !== false: ${JSON.stringify(opts)}`);
  }

  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
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
        onChanged: { addListener: (fn) => changeListeners.push(fn) },
      },
      runtime: { onMessage: { addListener: () => {} }, getManifest: () => ({ version: "0.0.0-test" }) },
      tabs: {
        create: (opts) => {
          auditTabCall(opts);
          const id = nextTabId++;
          tabsById.set(id, { url: opts.url, active: false, pinned: !!opts.pinned, muted: !!opts.muted });
          return Promise.resolve({ id });
        },
        update: (id, opts) => {
          auditTabCall(opts);
          const t = tabsById.get(id);
          if (t) Object.assign(t, opts);
          return Promise.resolve();
        },
        remove: (id) => {
          if (!tabsById.has(id)) return Promise.reject(new Error("no such tab"));
          tabsById.delete(id);
          return Promise.resolve();
        },
        get: (id) => tabsById.has(id) ? Promise.resolve({ id, ...tabsById.get(id) }) : Promise.reject(new Error("no such tab")),
        query: () => Promise.resolve([]),
        reload: () => {},
      },
      alarms: {
        create: (name) => liveAlarms.add(name),
        clear: (name) => { liveAlarms.delete(name); return Promise.resolve(true); },
        onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
      },
      browserAction: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
      downloads: {
        download: () => Promise.resolve(1),
        search: () => Promise.resolve([{ state: "complete", filename: "TEST/twitch-drop-claimer-debug.log" }]),
      },
    },
    URL: globalThis.URL,
    Blob: globalThis.Blob,
  };

  require("./window-stubs").attachWindowApis(sandbox.browser, { createTab: (o) => sandbox.browser.tabs.create({ ...o, active: false }) }); // 0.6.19: tabs only open in a verified, tagged watch window
  const ctx = vm.createContext(sandbox);

  function fireStorageChange(changes) {
    for (const fn of changeListeners) fn(changes, "local");
  }

  function flush(ms = 15) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return { ctx, storageData, tabsById, fireStorageChange, flush, get violations() { return violations; } };
}

function tabsForSlugs(watchTabs) {
  return Object.keys(watchTabs || {});
}

async function testQuotaFilling() {
  const { ctx, storageData, tabsById, flush } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);

  storageData.watchList = [
    { input: "poe2", slug: "path-of-exile-2" },
    { input: "diablo 4", slug: "diablo-iv" },
    { input: "dota2", slug: "dota-2" },
  ]; // quota is 2 (set in makeSandbox)

  vm.runInContext(read("background.js"), ctx);
  await flush(30);

  const watched = tabsForSlugs(storageData.watchTabs);
  assert.strictEqual(watched.length, 2, `expected exactly 2 tabs open (quota), got ${watched.length}`);
  assert.ok(watched.includes("path-of-exile-2") && watched.includes("diablo-iv"), "expected the first 2 list-order games to be watched, got: " + watched.join(","));
  assert.ok(!watched.includes("dota-2"), "3rd game should be queued, not watched, until a slot frees");
  // +1 for the separate inventory-upkeep tab background.js always ensures exists
  assert.strictEqual(tabsById.size, 3, "expected 2 watch tabs + 1 inventory tab");

  for (const slug of watched) {
    const t = tabsById.get(storageData.watchTabs[slug]);
    assert.strictEqual(t.muted, true, `watch tab for ${slug} must be muted via tabs.update`);
    assert.strictEqual(t.active, false, `watch tab for ${slug} must stay active:false`);
  }

  console.log("  OK  quota filling: only tabQuota tabs opened, extra games queued, all muted+inactive");
  return { storageData, tabsById };
}

async function testIndependentCompletion() {
  const { ctx, storageData, tabsById, flush } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);

  storageData.watchList = [
    { input: "poe2", slug: "path-of-exile-2" },
    { input: "diablo 4", slug: "diablo-iv" },
    { input: "dota2", slug: "dota-2" },
  ];

  vm.runInContext(read("background.js"), ctx);
  await flush(30);

  const before = { ...storageData.watchTabs };
  assert.strictEqual(Object.keys(before).length, 2, "sanity: 2 tabs open before completing one");

  // simulate the inventory content script reporting poe2 as fully claimed
  const campaigns = [{ slug: "path-of-exile-2", label: "Path of Exile 2", claimed: 3, total: 3, accountNotConnected: false, expired: false }];
  await vm.runInContext("mergeInventoryProgress", ctx)(campaigns);
  await flush(30);

  const after = storageData.watchTabs;
  assert.ok(!after["path-of-exile-2"], "poe2's tab should be closed now that it's fully claimed");
  assert.ok(after["diablo-iv"], "diablo-iv's tab must be untouched by poe2 finishing");
  assert.ok(after["dota-2"], "dota-2 should have taken the freed slot");
  assert.strictEqual(Object.keys(after).length, 2, "quota (2) should still be respected after backfilling");
  assert.strictEqual(tabsById.has(before["path-of-exile-2"]), false, "poe2's actual tab must have been removed, not just unlinked");

  console.log("  OK  independent completion: only the finished game's tab closes, others untouched, freed slot backfilled");
}

async function testAllDoneClosesEverything() {
  const { ctx, storageData, tabsById, flush } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);

  storageData.watchList = [
    { input: "poe2", slug: "path-of-exile-2" },
    { input: "diablo 4", slug: "diablo-iv" },
  ];
  storageData.tabQuota = 5;

  vm.runInContext(read("background.js"), ctx);
  await flush(30);
  assert.strictEqual(Object.keys(storageData.watchTabs).length, 2, "sanity: both games watched (quota 5 > 2 games)");

  const campaigns = [
    { slug: "path-of-exile-2", label: "PoE2", claimed: 3, total: 3, accountNotConnected: false, expired: false },
    { slug: "diablo-iv", label: "Diablo IV", claimed: 0, total: 0, accountNotConnected: false, expired: true },
  ];
  await vm.runInContext("mergeInventoryProgress", ctx)(campaigns);
  await flush(30);

  assert.strictEqual(Object.keys(storageData.watchTabs).length, 0, "all watch tabs should be closed once every game is done");
  // the separate inventory-upkeep tab is untouched by auto-watch completion - only watch tabs close
  assert.strictEqual(tabsById.size, 1, "only the unrelated inventory tab should remain open");
  assert.strictEqual(storageData.watchPhase, "all-done", "watchPhase must report all-done");

  console.log("  OK  all-done: every game finishing closes every tab and sets watchPhase=all-done");
}

// auto-off is now completion-based, not time-based: with the toggle on, the
// master switch flips off the moment every tracked game is done.
async function testAutoOffOnAllDone() {
  const { ctx, storageData, flush } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  storageData.autoOffEnabled = true;
  storageData.enabledSince = Date.now() - 60 * 60 * 1000; // an hour ago, past the re-enable grace window
  storageData.watchList = [{ input: "poe2", slug: "path-of-exile-2" }];
  storageData.tabQuota = 5;

  vm.runInContext(read("background.js"), ctx);
  await flush(30);
  assert.strictEqual(storageData.enabled, true, "sanity: still on while there's a game to watch");

  await vm.runInContext("mergeInventoryProgress", ctx)([
    { slug: "path-of-exile-2", label: "PoE2", claimed: 3, total: 3, accountNotConnected: false, expired: false },
  ]);
  await flush(30);

  assert.strictEqual(storageData.watchPhase, "all-done", "every game done -> all-done");
  assert.strictEqual(storageData.enabled, false, "auto-off toggle on -> master switch turned off");
  assert.ok(storageData.completedAllAt > 0, "records when it auto-offed so the popup can explain why");

  console.log("  OK  auto-off (completion-based): master switch flips off once every tracked game is done");
}

// "soonest expiry first" now orders on Twitch's own campaign endAt (known
// for every game with an open campaign), not just the subset whose
// inventory card had a parseable "End Date".
async function testExpiryPriorityUsesCampaignEndAt() {
  const { ctx, storageData, flush } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  storageData.priorityMode = "expiry";
  storageData.tabQuota = 1; // only the top-priority game gets watched
  const soon = Date.now() + 2 * 8.64e7;
  const later = Date.now() + 20 * 8.64e7;
  storageData.watchList = [
    { input: "Later Game", slug: "later-game", campaign: { open: true, endAt: later } },
    { input: "Soon Game", slug: "soon-game", campaign: { open: true, endAt: soon } },
  ];
  storageData.openCampaigns = freshOpenCampaigns({
    "later-game": { slug: "later-game", displayName: "Later Game", gameId: "1", active: true, endAt: later },
    "soon-game": { slug: "soon-game", displayName: "Soon Game", gameId: "2", active: true, endAt: soon },
  });

  vm.runInContext(read("background.js"), ctx);
  await flush(30);

  assert.ok(storageData.watchTabs["soon-game"], "the sooner-expiring campaign is watched first, despite being 2nd in list order");
  assert.ok(!storageData.watchTabs["later-game"], "the later-expiring one waits for a free slot");
  console.log("  OK  expiry priority orders on the GQL campaign endAt, not just inventory-parsed dates");
}

async function testAutoOffRespectsReenableGrace() {
  const { ctx, storageData, flush } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  storageData.autoOffEnabled = true;
  storageData.enabledSince = Date.now(); // just re-enabled
  storageData.watchPhase = "all-done";
  storageData.watchList = [{ input: "poe2", slug: "path-of-exile-2" }];
  storageData.campaignProgress = { "path-of-exile-2": { claimed: 3, total: 3, allComplete: true } };

  vm.runInContext(read("background.js"), ctx);
  await flush(30);

  assert.strictEqual(storageData.enabled, true,
    "a fresh manual re-enable gets a grace window - not instantly auto-offed even though everything is still done");
  console.log("  OK  auto-off honours a short grace window after a manual re-enable");
}

// handleDirectoryInvalid() used to permanently blacklist a slug (a plain
// array, never cleared). Changed to a cooldown (INVALID_SLUG_RETRY_MS)
// after a real, genuinely-correct category ("path-of-exile-2") got marked
// invalid by a transient redirect/timing false-positive and then sat
// un-watched forever with no way to recover short of removing and
// re-adding the game in the popup.
async function testInvalidSlugRetriesAfterCooldown() {
  const { ctx, storageData, tabsById, flush } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  storageData.watchList = [{ input: "poe2", slug: "path-of-exile-2" }];

  vm.runInContext(read("background.js"), ctx);
  await flush(30);
  const tabId = storageData.watchTabs["path-of-exile-2"];
  assert.ok(tabId, "sanity: watch tab opened for the only game");

  await vm.runInContext("handleDirectoryInvalid", ctx)("path-of-exile-2", "/directory/category/path-of-exile-2-blocked", "https://www.twitch.tv/directory/category/path-of-exile-2-blocked");
  await flush(20);

  assert.ok(!storageData.watchTabs["path-of-exile-2"], "the tab must be closed while marked invalid");
  assert.ok(!tabsById.has(tabId), "the actual tab must be removed, not just unlinked");
  assert.ok(
    storageData.invalidSlugs["path-of-exile-2"] > Date.now(),
    "invalidSlugs must record a future retry-after timestamp, not a permanent flag"
  );

  // cooldown expires - the next autoWatchTick sweep must pick it back up
  // on its own, no popup action needed
  storageData.invalidSlugs["path-of-exile-2"] = Date.now() - 1000;
  await vm.runInContext("autoWatchTick", ctx)();
  await flush(20);

  assert.ok(storageData.watchTabs["path-of-exile-2"], "a fresh watch tab must open again once the cooldown has passed");

  console.log("  OK  a slug marked invalid retries automatically after its cooldown, not blacklisted forever");
}

function freshOpenCampaigns(bySlug) {
  return { fetchedAt: Date.now(), bySlug };
}

// A game with no open drop campaign in a fresh /drops/campaigns snapshot is
// skipped by auto-watch (not watched, not "all-done"), and picked up on its
// own once a campaign for it appears.
async function testSkipsGameWithNoOpenCampaign() {
  const { ctx, storageData, flush } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);

  storageData.watchList = [
    { input: "marvel rivals", slug: "marvel-rivals" },
    { input: "poe2", slug: "path-of-exile-2" },
  ];
  storageData.openCampaigns = freshOpenCampaigns({
    "marvel-rivals": { slug: "marvel-rivals", displayName: "Marvel Rivals", gameId: "1264310518", active: true, endAt: Date.now() + 8.64e7, accountConnected: true },
    "some-other-game": { slug: "some-other-game", displayName: "Some Other Game", gameId: "999", active: true, endAt: null, accountConnected: false },
  });

  vm.runInContext(read("background.js"), ctx);
  await flush(30);

  assert.ok(storageData.watchTabs["marvel-rivals"], "a game with an open campaign is watched normally");
  assert.ok(!storageData.watchTabs["path-of-exile-2"], "a game with NO open campaign in the fresh snapshot is skipped");
  assert.notStrictEqual(storageData.watchPhase, "all-done", "one game merely waiting on a campaign is not 'all-done'");

  // poe2's campaign opens -> next sweep picks it up
  storageData.openCampaigns = freshOpenCampaigns({
    ...storageData.openCampaigns.bySlug,
    "path-of-exile-2": { slug: "path-of-exile-2", displayName: "Path of Exile 2", gameId: "1702520304", active: true, endAt: Date.now() + 8.64e7, accountConnected: true },
  });
  await vm.runInContext("autoWatchTick", ctx)();
  await flush(20);

  assert.ok(storageData.watchTabs["path-of-exile-2"], "once a campaign appears for the game, auto-watch starts it - no popup action");
  console.log("  OK  a game with no open drop campaign is skipped, then auto-resumes once a campaign opens");
}

// A manual "start watching from <date>" gates auto-watch until that date,
// then releases it on its own.
async function testWaitUntilDateGatesAutoWatch() {
  const { ctx, storageData, flush } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);

  storageData.watchList = [{ input: "path of exile 2", slug: "path-of-exile-2" }];
  storageData.openCampaigns = freshOpenCampaigns({
    "path-of-exile-2": { slug: "path-of-exile-2", displayName: "Path of Exile 2", gameId: "1702520304", active: true, endAt: Date.now() + 8.64e7, accountConnected: true },
  });
  storageData.gameWaitUntil = { "path-of-exile-2": Date.now() + 3 * 8.64e7 }; // 3 days out

  vm.runInContext(read("background.js"), ctx);
  await flush(30);

  assert.ok(!storageData.watchTabs["path-of-exile-2"], "a future wait-until date keeps auto-watch from starting the game");

  storageData.gameWaitUntil = { "path-of-exile-2": Date.now() - 1000 }; // date has now passed
  await vm.runInContext("autoWatchTick", ctx)();
  await flush(20);

  assert.ok(storageData.watchTabs["path-of-exile-2"], "once the wait-until date passes, auto-watch starts the game on its own");
  console.log("  OK  a manual wait-until date gates auto-watch until it passes, then releases automatically");
}

// A guessed directory slug that renders a blank "unknown category" page
// (content.js's looksLikeUnknownCategory -> directoryUnknownCategory) is
// resolved to the real slug via Twitch search: background opens /search,
// content.js posts back searchCategoryResult, and the watch-list slug +
// gameSlugMap are corrected in place so it's a one-time cost per game.
async function testUnknownCategorySlugResolvedViaSearch() {
  const { ctx, storageData, tabsById, flush } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);

  storageData.watchList = [{ input: "Rainbow Six Siege", slug: "rainbow-six-siege", gameId: "460630", campaign: { open: true } }];
  storageData.openCampaigns = freshOpenCampaigns({
    "rainbow-six-siege": { slug: "rainbow-six-siege", displayName: "Rainbow Six Siege", gameId: "460630", active: true, endAt: Date.now() + 8.64e7, accountConnected: true },
  });

  vm.runInContext(read("background.js"), ctx);
  await flush(30);
  assert.ok(storageData.watchTabs["rainbow-six-siege"], "sanity: a directory tab opened for the guessed slug");

  // content.js on that directory tab decides it's a blank unknown category
  const p = vm.runInContext("handleDirectoryUnknownCategory", ctx)({
    type: "directoryUnknownCategory", slug: "rainbow-six-siege", gameName: "Rainbow Six Siege",
  });
  await flush(20);

  // a /search tab must have been opened
  const searchTab = [...tabsById.values()].find((t) => (t.url || "").includes("/search?term="));
  assert.ok(searchTab, "background must open a Twitch search tab to resolve the real slug");
  assert.ok(/Rainbow(%20| )Six(%20| )Siege/i.test(searchTab.url), "search term is the game name");

  // content.js on the /search page scrapes the category result and posts it back
  vm.runInContext("handleSearchCategoryResult", ctx)({
    type: "searchCategoryResult", term: "Rainbow Six Siege", slug: "tom-clancys-rainbow-six-siege",
  });
  await p;
  await flush(20);

  assert.strictEqual(storageData.watchList[0].slug, "tom-clancys-rainbow-six-siege",
    "the watch-list entry's slug is corrected to the real one from search");
  assert.strictEqual((storageData.gameSlugMap || {})["460630"], "tom-clancys-rainbow-six-siege",
    "the id -> slug mapping is cached so future snapshots don't guess wrong again");
  assert.ok(!(storageData.invalidSlugs || {})["tom-clancys-rainbow-six-siege"], "the corrected slug is not left in a cooldown");
  assert.ok(!(storageData.invalidSlugs || {})["rainbow-six-siege"], "the bad slug's cooldown entry is cleared");
  assert.ok(storageData.watchTabs["tom-clancys-rainbow-six-siege"], "auto-watch reopens the directory with the corrected slug");
  assert.ok(![...tabsById.values()].some((t) => (t.url || "").includes("/search?term=")), "the transient search tab is closed");

  console.log("  OK  a wrong guessed slug is resolved to the real one via Twitch search, cached in gameSlugMap, and re-watched");
}

async function testUnknownCategoryFallsBackToInvalidWhenSearchFails() {
  const { ctx, storageData, flush } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  storageData.watchList = [{ input: "Nonexistent Game", slug: "nonexistent-game", campaign: { open: true } }];
  storageData.openCampaigns = freshOpenCampaigns({
    "nonexistent-game": { slug: "nonexistent-game", displayName: "Nonexistent Game", gameId: "0", active: true, endAt: Date.now() + 8.64e7 },
  });
  vm.runInContext(read("background.js"), ctx);
  await flush(30);

  // no searchCategoryResult ever comes back -> after the timeout it must
  // fall back to the normal invalid-slug cooldown, not hang forever
  const p = vm.runInContext("handleDirectoryUnknownCategory", ctx)({
    type: "directoryUnknownCategory", slug: "nonexistent-game", gameName: "Nonexistent Game",
  });
  // don't wait the full 25s real timeout - just verify it parked the slug immediately
  await flush(30);
  assert.ok((storageData.invalidSlugs || {})["nonexistent-game"] > Date.now(),
    "the bad slug is parked in a cooldown right away while the search runs (and stays parked if search fails)");
  assert.ok(!storageData.watchTabs["nonexistent-game"], "its directory tab is closed while resolving");
  p.catch(() => {}); // let the 25s timeout resolve in the background, don't block the test
  console.log("  OK  an unresolvable unknown category parks the slug immediately and doesn't hang the scheduler");
}

// real capture (2026-08-28): a game (marvel-rivals) had two campaign cards
// on the inventory page at once - an old one past its end date and a
// current active one, both same boxart id/slug. content.js dedupes those
// itself now, but as a second line of defense, mergeInventoryProgress must
// not close/mark-done a game's tab from a DOM `expired:true` report if
// Twitch's own GQL campaign.status (learned into gameActiveIds alongside
// gameIdMap - see inject.js's Inventory extractor) says that game still
// has an ACTIVE campaign.
async function testGqlActiveOverridesDomExpiredFalsePositive() {
  const { ctx, storageData, tabsById, flush } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  storageData.watchList = [{ input: "marvel rivals", slug: "marvel-rivals" }];
  storageData.gameIdMap = { "1264310518": "Marvel Rivals" };
  storageData.gameActiveIds = { "1264310518": true };

  vm.runInContext(read("background.js"), ctx);
  await flush(30);
  const tabId = storageData.watchTabs["marvel-rivals"];
  assert.ok(tabId, "sanity: watch tab opened for marvel-rivals");

  const campaigns = [
    { slug: "marvel-rivals", label: "Marvel Rivals", claimed: 0, total: 1, accountNotConnected: false, expired: true },
  ];
  await vm.runInContext("mergeInventoryProgress", ctx)(campaigns);
  await flush(30);

  assert.ok(storageData.watchTabs["marvel-rivals"], "the tab must stay open - GQL confirms an active campaign still exists");
  assert.ok(tabsById.has(tabId), "the actual tab must not have been removed");
  assert.strictEqual(storageData.campaignProgress["marvel-rivals"].expired, false, "the stored expired flag must reflect the GQL override, not the raw DOM report");

  console.log("  OK  a GQL-confirmed still-active campaign overrides a DOM false-positive expired report (marvel-rivals two-cards scenario)");
}

async function testNoTabViolations() {
  const { ctx, storageData, flush, violations } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  storageData.watchList = [
    { input: "poe2", slug: "path-of-exile-2" },
    { input: "diablo 4", slug: "diablo-iv" },
    { input: "dota2", slug: "dota-2" },
  ];
  vm.runInContext(read("background.js"), ctx);
  await flush(30);

  assert.deepStrictEqual(violations, [], `found tabs.create/update calls without active:false: ${violations.join("; ")}`);
  // matches an actual call (browser.windows.update(...)), not the doc-comment mentioning it by name
  assert.ok(!/browser\.windows\.update\(/.test(read("background.js")), "background.js must never call windows.update");

  console.log("  OK  tab-etiquette audit: every tabs.create/update passed active:false, no windows.update anywhere");
}

// Adds a browser.windows mock (the base sandbox above has none, so
// getOrCreateWatchWindow always fails closed and never flashes - that's
// what testNoTabViolations locks in for the no-windows-API case). With
// windows.create/get available, background.js should route every tab it
// opens into one dedicated window, and flashTabToStartPlayback's brief
// active:true is only ever allowed on a tab confirmed to be inside it -
// see the "Tab etiquette" comment at the top of background.js.
function makeSandboxWithWatchWindow() {
  const MAIN_WINDOW_ID = 1; // stands in for "whatever window the user is using"
  const storageData = {
    enabled: true, autoWatchEnabled: true, tabQuota: 2,
    openCampaigns: { fetchedAt: Date.now(), bySlug: {} },
  };
  const changeListeners = [];
  const alarmListeners = [];
  const tabsById = new Map();
  const windowsById = new Map([[MAIN_WINDOW_ID, { id: MAIN_WINDOW_ID, focused: true, type: "normal" }]]);
  let nextTabId = 1;
  let nextWindowId = MAIN_WINDOW_ID + 1;
  // any active:true call on a tab NOT inside the dedicated watch window
  // would be a real focus-stealing bug in the window the user is using
  let unsafeActivations = [];

  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
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
        onChanged: { addListener: (fn) => changeListeners.push(fn) },
      },
      runtime: { onMessage: { addListener: () => {} }, getManifest: () => ({ version: "0.0.0-test" }) },
      windows: {
        create: (opts) => {
          const id = nextWindowId++;
          windowsById.set(id, { id, focused: true, type: opts.type || "normal" });
          // real windows.create() always returns the window's initial tab
          // (blank/new-tab-page when no url is given) - mirror that so
          // getOrCreateWatchWindow's tabs.update(initialTab.id, ...) has a
          // real tab to navigate, same as in Firefox
          const tabId = nextTabId++;
          tabsById.set(tabId, { url: opts.url || "about:blank", active: false, pinned: false, muted: false, windowId: id });
          return Promise.resolve({ id, tabs: [{ id: tabId, windowId: id }] });
        },
        get: (id) => windowsById.has(id) ? Promise.resolve({ ...windowsById.get(id) }) : Promise.reject(new Error("no such window")),
      },
      tabs: {
        create: (opts) => {
          const id = nextTabId++;
          const windowId = opts.windowId != null ? opts.windowId : MAIN_WINDOW_ID;
          tabsById.set(id, { url: opts.url, active: false, pinned: !!opts.pinned, muted: !!opts.muted, windowId });
          return Promise.resolve({ id, windowId });
        },
        update: (id, opts) => {
          const t = tabsById.get(id);
          if (t) {
            if (opts.active === true && t.windowId !== storageData.watchWindowId) {
              unsafeActivations.push(`tab ${id} in window ${t.windowId} (watch window is ${storageData.watchWindowId})`);
            }
            Object.assign(t, opts);
          }
          return Promise.resolve();
        },
        remove: (id) => {
          if (!tabsById.has(id)) return Promise.reject(new Error("no such tab"));
          tabsById.delete(id);
          return Promise.resolve();
        },
        get: (id) => tabsById.has(id) ? Promise.resolve({ id, ...tabsById.get(id) }) : Promise.reject(new Error("no such tab")),
        query: () => Promise.resolve([]),
        reload: () => {},
      },
      alarms: {
        create: () => {},
        clear: () => Promise.resolve(true),
        onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
      },
      browserAction: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
      downloads: {
        download: () => Promise.resolve(1),
        search: () => Promise.resolve([{ state: "complete", filename: "TEST/twitch-drop-claimer-debug.log" }]),
      },
    },
    URL: globalThis.URL,
    Blob: globalThis.Blob,
  };

  const ctx = vm.createContext(sandbox);
  function flush(ms = 15) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return { ctx, storageData, tabsById, flush, get unsafeActivations() { return unsafeActivations; }, MAIN_WINDOW_ID };
}

async function testWatchTabsIsolatedInDedicatedWindow() {
  const { ctx, storageData, tabsById, flush, MAIN_WINDOW_ID } = makeSandboxWithWatchWindow();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  storageData.watchList = [{ input: "poe2", slug: "path-of-exile-2" }];

  vm.runInContext(read("background.js"), ctx);
  await flush(30);

  assert.ok(storageData.watchWindowId, "a dedicated watch window must have been created");
  assert.notStrictEqual(storageData.watchWindowId, MAIN_WINDOW_ID, "the watch window must not be the user's own window");

  const watchTabId = storageData.watchTabs["path-of-exile-2"];
  assert.strictEqual(tabsById.get(watchTabId).windowId, storageData.watchWindowId, "the watch tab must be opened inside the dedicated window, not the user's");

  console.log("  OK  watch tabs open inside a dedicated window, never the user's own");
}

async function testFreshChannelPickFlashesOnlyInsideWatchWindowThenReverts() {
  const { ctx, storageData, tabsById, flush, unsafeActivations } = makeSandboxWithWatchWindow();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  storageData.watchList = [{ input: "poe2", slug: "path-of-exile-2" }];

  vm.runInContext(read("background.js"), ctx);
  await flush(30);
  const tabId = storageData.watchTabs["path-of-exile-2"];

  await vm.runInContext("handleDirectoryPicked", ctx)("path-of-exile-2", "streamerZ", { id: tabId });
  await flush(20); // long enough for the fire-and-forget flash to activate, well under any real hold

  assert.strictEqual(tabsById.get(tabId).active, true, "a freshly-picked channel's tab must be briefly activated to start Twitch's player");
  assert.deepStrictEqual(unsafeActivations, [], "active:true must only ever happen on a tab inside the dedicated watch window");

  // exercise the revert directly with a short hold instead of waiting out
  // the real ~8s default - same function, just a smaller holdMs
  await vm.runInContext("flashTabToStartPlayback", ctx)(tabId, 20);
  await flush(60);
  assert.strictEqual(tabsById.get(tabId).active, false, "the tab must be switched back to active:false after the hold");

  console.log("  OK  a freshly-picked channel is briefly activated inside the watch window only, then reverted");
}

// Regression test: a live run (2026-09-04) opened two /drops/inventory tabs
// - the dedicated watch window's own freshly-created initial tab (navigated
// to INVENTORY_URL by getOrCreateWatchWindow), plus a second one from
// openInventoryIfMissing's own explicit tabs.create fallback, because it
// re-queried browser.tabs right after window creation instead of trusting
// getOrCreateWatchWindow's freshlyCreated flag - a real TOCTOU gap.
async function testNoDuplicateInventoryTabOnFirstWatchWindowCreation() {
  const { ctx, storageData, tabsById, flush } = makeSandboxWithWatchWindow();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  storageData.watchList = [{ input: "poe2", slug: "path-of-exile-2" }];

  vm.runInContext(read("background.js"), ctx);
  await flush(30);

  const inventoryTabs = [...tabsById.values()].filter((t) => (t.url || "").includes("drops/inventory"));
  assert.strictEqual(inventoryTabs.length, 1, `expected exactly 1 inventory tab, got ${inventoryTabs.length}`);

  console.log("  OK  creating the dedicated watch window for the first time opens exactly one inventory tab, not two");
}

// Regression test: once every reward tier of a campaign is claimed, Twitch
// moves/removes that game's card from /drops/inventory's "In Progress"
// section entirely (parseInventoryCampaigns has no selector scoped to
// wherever it goes) - so a real live report (2026-09-15) never sees a
// "claimed >= total" reading for it at all, and its watch tab/badge stayed
// stuck at its last real numbers forever. mergeInventoryProgress's
// missing-card reconciliation must infer allComplete once a watched game
// with prior real progress goes missing from REQUIRED_MISSING_SCANS
// consecutive scans - but not react to just one (a mid-render hiccup).
async function testCardVanishedFromInProgressMarksComplete() {
  const { ctx, storageData, tabsById, flush } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);

  storageData.watchList = [
    { input: "poe2", slug: "path-of-exile-2" },
    { input: "diablo 4", slug: "diablo-iv" },
  ];

  vm.runInContext(read("background.js"), ctx);
  await flush(30);
  assert.ok(storageData.watchTabs["path-of-exile-2"], "sanity: poe2 tab open");

  // both cards still show real, incomplete progress
  const poeTiers = [{ name: "Tier A", claimed: true }, { name: "Tier B", claimed: true }, { name: "Tier C", claimed: false }];
  await vm.runInContext("mergeInventoryProgress", ctx)([
    { slug: "path-of-exile-2", label: "PoE2", claimed: 2, total: 3, accountNotConnected: false, expired: false, tiers: poeTiers },
    { slug: "diablo-iv", label: "Diablo IV", claimed: 1, total: 2, accountNotConnected: false, expired: false },
  ], [["Tier A", 1], ["Tier B", 1]]);
  await flush(20);

  // poe2's card is gone from this scan (1st miss) - must not act yet
  const claimedAll = [["Tier A", 1], ["Tier B", 1], ["Tier C", 1]]; // the last reward is in the Claimed section now
  await vm.runInContext("mergeInventoryProgress", ctx)([
    { slug: "diablo-iv", label: "Diablo IV", claimed: 1, total: 2, accountNotConnected: false, expired: false },
  ], claimedAll);
  await flush(20);
  assert.ok(storageData.watchTabs["path-of-exile-2"], "a single missed scan must not close the tab yet");
  assert.strictEqual(storageData.campaignProgress["path-of-exile-2"].allComplete, false);

  // poe2's card still missing (2nd consecutive miss) AND its rewards are in Claimed - confirmed complete
  await vm.runInContext("mergeInventoryProgress", ctx)([
    { slug: "diablo-iv", label: "Diablo IV", claimed: 1, total: 2, accountNotConnected: false, expired: false },
  ], claimedAll);
  await flush(20);

  assert.strictEqual(storageData.campaignProgress["path-of-exile-2"].allComplete, true,
    "two consecutive misses with the rewards in Claimed must mark the vanished card's campaign complete");
  assert.strictEqual(storageData.campaignProgress["path-of-exile-2"].claimed, 3, "counted as 3/3, not the 2/3 of the last reading");
  assert.ok(!storageData.watchTabs["path-of-exile-2"], "poe2's tab must close once inferred complete");
  assert.ok(storageData.watchTabs["diablo-iv"], "diablo-iv, still reporting normally, must be untouched");
  assert.strictEqual(storageData.campaignProgress["diablo-iv"].allComplete, false);

  console.log("  OK  a watched game's card vanishing from In Progress across 2 scans with its rewards in Claimed is confirmed fully claimed, closing its tab");
}

(async () => {
  console.log("Running multi-tab auto-watch tests (no real browser, no network)...\n");
  try {
    await testQuotaFilling();
    await testIndependentCompletion();
    await testAllDoneClosesEverything();
    await testAutoOffOnAllDone();
    await testAutoOffRespectsReenableGrace();
    await testExpiryPriorityUsesCampaignEndAt();
    await testInvalidSlugRetriesAfterCooldown();
    await testSkipsGameWithNoOpenCampaign();
    await testWaitUntilDateGatesAutoWatch();
    await testUnknownCategorySlugResolvedViaSearch();
    await testUnknownCategoryFallsBackToInvalidWhenSearchFails();
    await testGqlActiveOverridesDomExpiredFalsePositive();
    await testNoTabViolations();
    await testWatchTabsIsolatedInDedicatedWindow();
    await testFreshChannelPickFlashesOnlyInsideWatchWindowThenReverts();
    await testNoDuplicateInventoryTabOnFirstWatchWindowCreation();
    await testCardVanishedFromInProgressMarksComplete();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    process.exit(1);
  }
})();
