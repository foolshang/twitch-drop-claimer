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
  const storageData = { enabled: true, autoWatchEnabled: true, tabQuota: 2 };
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
      runtime: { onMessage: { addListener: () => {} } },
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
    },
  };

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

async function testNoTabViolations() {
  const { ctx, storageData, flush, violations } = makeSandbox();
  vm.runInContext(read("shared.js"), ctx);
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

(async () => {
  console.log("Running multi-tab auto-watch tests (no real browser, no network)...\n");
  try {
    await testQuotaFilling();
    await testIndependentCompletion();
    await testAllDoneClosesEverything();
    await testNoTabViolations();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    process.exit(1);
  }
})();
