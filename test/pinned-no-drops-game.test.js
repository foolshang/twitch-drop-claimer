/**
 * pinned-no-drops-game.test.js
 *
 * "@DisguisedToast (MECCHA CHAMELEON)" showed "watching" and held a quota slot, but it matched no campaign
 * and the game it plays has no drops campaign at all - the slot was spent for nothing. Now an UNMATCHED
 * pinned channel playing a game with no open campaign is parked like a channel on the wrong game
 * (0.6.18): popup "playing a game with no drops - not earning drops" (9 languages), no quota slot, its
 * tab stays open (and counts toward the cap of 5), back to watching once it plays a game that has a
 * campaign. FAIL OPEN: only when the data positively shows there is none - a stale or empty snapshot,
 * no Inventory GQL yet, or a game not resolved yet keeps the channel watched.
 *
 * Real background.js with an in-memory tabs registry + the real popup.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { renderPopupRows } = require("./campaign-matching.test.js");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const { I18N, I18N_LANGS } = require("../i18n.js");
const en = I18N.en;
const HOUR = 3_600_000;

function makeWorld(storage) {
  const storageData = { enabled: true, autoWatchEnabled: true, tabQuota: 2, ...storage };
  const listeners = [];
  const tabsById = new Map();
  let nextTabId = 1;
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
        onChanged: { addListener: () => {} },
      },
      runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, getManifest: () => ({ version: "0.0.0-test" }) },
      tabs: {
        create: (opts) => { const id = nextTabId++; tabsById.set(id, { url: opts.url }); return Promise.resolve({ id }); },
        update: () => Promise.resolve(),
        remove: (id) => (tabsById.delete(id) ? Promise.resolve() : Promise.reject(new Error("no such tab"))),
        get: (id) => (tabsById.has(id) ? Promise.resolve({ id, ...tabsById.get(id) }) : Promise.reject(new Error("no such tab"))),
        query: () => Promise.resolve([]),
        reload: () => {},
      },
      alarms: { create: () => {}, clear: () => Promise.resolve(true), onAlarm: { addListener: () => {} } },
      browserAction: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
      downloads: { download: () => Promise.resolve(1), search: () => Promise.resolve([{ state: "complete", filename: "x" }]) },
    },
    URL: globalThis.URL,
    Blob: globalThis.Blob,
  };
  require("./window-stubs").attachWindowApis(sandbox.browser, { createTab: (o) => sandbox.browser.tabs.create({ ...o, active: false }) });
  const ctx = vm.createContext(sandbox);
  const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));
  return {
    ctx, storageData, flush,
    tabs: () => Object.keys(storageData.watchTabs || {}).sort(),
    noDrops: () => Object.keys(storageData.pinnedNoDrops || {}).filter((k) => storageData.pinnedNoDrops[k]).sort(),
    logs: () => vm.runInContext("debugLogBuffer.slice()", ctx),
    async boot() {
      vm.runInContext(read("shared.js"), ctx);
      vm.runInContext(read("i18n.js"), ctx);
      vm.runInContext(read("background.js"), ctx);
      await flush(80);
    },
    async tick() { await vm.runInContext("serialized(autoWatchTick)", ctx); await flush(); },
  };
}

const pin = (name, extra = {}) => ({ input: `@${name}`, slug: `channel:${name}`, channel: name, pinnedChannel: true, ...extra });
const game = (slug) => ({ input: slug, slug });
const DT = (extra = {}) => pin("disguisedtoast", { gameSlug: "meccha-chameleon", pinnedGameName: "MECCHA CHAMELEON", ...extra });

// a fresh, non-empty /drops/campaigns snapshot: Rust has an open campaign, MECCHA CHAMELEON is not in it
const snapshot = (over = {}) => ({
  fetchedAt: Date.now(),
  bySlug: {
    rust: { slug: "rust", displayName: "Rust", active: true }, warframe: { slug: "warframe", displayName: "Warframe", active: false },
    // the plain game entries of the tests have open campaigns (a game without one is not even eligible)
    x: { slug: "x", displayName: "x", active: true }, y: { slug: "y", displayName: "y", active: true }, g: { slug: "g", displayName: "g", active: true },
    ...over,
  },
});
// the Inventory GQL: a Rust campaign restricted to other channels
const inventory = (over = {}) => ({
  at: Date.now(),
  byId: { c1: { id: "c1", name: "Rust Isles Tac Gloves", status: "ACTIVE", gameName: "Rust", channels: ["itsryanhiga"] }, ...over },
});

async function testUnmatchedChannelOnAGameWithNoDropsHoldsNoSlot() {
  const w = makeWorld({ tabQuota: 2, watchList: [DT(), game("x"), game("y")], openCampaigns: snapshot(), inventoryCampaigns: inventory() });
  await w.boot();
  assert.deepStrictEqual(w.tabs(), ["channel:disguisedtoast", "x", "y"], "DisguisedToast's tab is open but the quota of 2 goes to x and y: " + w.tabs());
  assert.deepStrictEqual(w.noDrops(), ["channel:disguisedtoast"], "marked for the popup");
  assert.ok(w.logs().some((l) => /pinned channel disguisedtoast is playing MECCHA CHAMELEON, which has no open drops campaign, and is not matched to one/.test(l)), "logged why");
  console.log("  OK  unmatched pinned channel on a game with no campaign (fresh snapshot): no slot, tab stays, games get the slots");
}

async function testSwitchingToAGameWithACampaignIsWatchingAgain() {
  const w = makeWorld({ tabQuota: 2, watchList: [DT(), game("x"), game("y")], openCampaigns: snapshot(), inventoryCampaigns: inventory() });
  await w.boot();
  assert.deepStrictEqual(w.noDrops(), ["channel:disguisedtoast"]);
  w.storageData.watchList = [DT({ gameSlug: "rust", pinnedGameName: "Rust" }), game("x"), game("y")]; // now plays Rust
  await w.tick();
  assert.deepStrictEqual(w.noDrops(), [], "a game with an open campaign: back to watching (holds a slot again)");
  console.log("  OK  switching to a game that has a campaign: watching again");
}

async function testFailsOpenWithoutPositiveData() {
  const cases = [
    ["a stale snapshot", { openCampaigns: { ...snapshot(), fetchedAt: Date.now() - 7 * HOUR }, inventoryCampaigns: inventory() }, DT()],
    ["an empty snapshot", { openCampaigns: { fetchedAt: Date.now(), bySlug: {} }, inventoryCampaigns: inventory() }, DT()],
    ["no snapshot", { inventoryCampaigns: inventory() }, DT()],
    ["no Inventory GQL read yet", { openCampaigns: snapshot() }, DT()],
    ["a game that is not resolved yet", { openCampaigns: snapshot(), inventoryCampaigns: inventory() }, pin("disguisedtoast")],
  ];
  for (const [label, data, entry] of cases) {
    const w = makeWorld({ tabQuota: 2, watchList: [entry, game("x"), game("y")], ...data });
    await w.boot();
    assert.deepStrictEqual(w.noDrops(), [], `${label}: keeps watching`);
    assert.deepStrictEqual(w.tabs().includes("y"), false, `${label}: it holds a quota slot as before (y waits)`);
  }
  console.log("  OK  fail open: stale / empty / missing snapshot, no Inventory GQL, unresolved game -> still watched");
}

async function testMatchedAndGeneralCampaignEntriesAreUnaffected() {
  // 1. the channel is in the allow list of an ACTIVE campaign (matched): never "no drops", whatever it plays
  let w = makeWorld({ tabQuota: 2, watchList: [DT(), game("x"), game("y")], openCampaigns: snapshot(),
    inventoryCampaigns: inventory({ c9: { id: "c9", name: "Mine", status: "ACTIVE", gameName: "Rust", channels: ["disguisedtoast"] } }) });
  await w.boot();
  assert.deepStrictEqual(w.noDrops(), [], "listed in an active campaign's allow channels");
  // 2. an entry with a matched card (progress with campaign ids)
  w = makeWorld({ tabQuota: 2, watchList: [DT(), game("x"), game("y")], openCampaigns: snapshot(), inventoryCampaigns: inventory(),
    campaignProgress: { "channel:disguisedtoast": { claimed: 0, total: 1, allComplete: false, expired: false, campaignIds: ["c1"], updatedAt: 1 } } });
  await w.boot();
  assert.deepStrictEqual(w.noDrops(), [], "an entry with a matched card");
  // 3. the game has a general (unrestricted) campaign in the Inventory GQL
  w = makeWorld({ tabQuota: 2, watchList: [DT(), game("x"), game("y")], openCampaigns: snapshot(),
    inventoryCampaigns: inventory({ c2: { id: "c2", name: "General", status: "ACTIVE", gameName: "MECCHA CHAMELEON", channels: null } }) });
  await w.boot();
  assert.deepStrictEqual(w.noDrops(), [], "the game has an active campaign in the Inventory GQL");
  // 4. the game is active in the snapshot
  w = makeWorld({ tabQuota: 2, watchList: [DT(), game("x"), game("y")], inventoryCampaigns: inventory(),
    openCampaigns: snapshot({ "meccha-chameleon": { slug: "meccha-chameleon", displayName: "MECCHA CHAMELEON", active: true } }) });
  await w.boot();
  assert.deepStrictEqual(w.noDrops(), [], "the game is active in the snapshot");
  // 5. a plain game entry is never touched
  w = makeWorld({ tabQuota: 1, watchList: [game("x")], openCampaigns: snapshot(), inventoryCampaigns: inventory() });
  await w.boot();
  assert.deepStrictEqual(w.noDrops(), []);
  console.log("  OK  matched entries, a game with a campaign (GQL or snapshot) and game entries are unaffected");
}

async function testTheNoDropsTabsCountTowardTheCapOfFive() {
  const names = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
  const w = makeWorld({ tabQuota: 1, watchList: [...names.map((n) => pin(n, { gameSlug: "meccha-chameleon", pinnedGameName: "MECCHA CHAMELEON" })), game("g")], openCampaigns: snapshot(), inventoryCampaigns: inventory() });
  await w.boot();
  await w.tick(); await w.tick();
  assert.deepStrictEqual(w.tabs(), ["channel:a1", "channel:a2", "channel:a3", "channel:a4", "channel:a5", "g"], "five no-drops tabs at most, the game has the slot: " + w.tabs());
  console.log("  OK  no-drops tabs count toward the cap of 5 (the rest wait without a tab)");
}

async function testPopupSaysSoInNineLanguages() {
  const base = { watchList: [DT()], watchTabs: { "channel:disguisedtoast": 7 }, pinnedLive: { "channel:disguisedtoast": { tabId: 7, state: "live", at: 1 } } };
  let rows = await renderPopupRows({ ...base, pinnedNoDrops: { "channel:disguisedtoast": true } });
  assert.strictEqual(rows[0].badge, en.badge_no_drops_game, "badge: " + rows[0].badge);
  assert.notStrictEqual(rows[0].badge, en.badge_watching);
  rows = await renderPopupRows({ ...base, pinnedNoDrops: {} });
  assert.strictEqual(rows[0].badge, en.badge_watching, "without the flag: watching");
  for (const { code } of I18N_LANGS) {
    assert.ok(I18N[code].badge_no_drops_game && I18N[code].badge_no_drops_game.length > 3, `${code} has the text`);
    if (code !== "en") assert.notStrictEqual(I18N[code].badge_no_drops_game, en.badge_no_drops_game, `${code} is translated`);
  }
  console.log("  OK  popup: 'playing a game with no drops - not earning drops' (9 languages), watching without the flag");
}

(async () => {
  console.log("Running pinned no-drops-game tests (real background.js + popup)...\n");
  try {
    await testUnmatchedChannelOnAGameWithNoDropsHoldsNoSlot();
    await testSwitchingToAGameWithACampaignIsWatchingAgain();
    await testFailsOpenWithoutPositiveData();
    await testMatchedAndGeneralCampaignEntriesAreUnaffected();
    await testTheNoDropsTabsCountTowardTheCapOfFive();
    await testPopupSaysSoInNineLanguages();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
