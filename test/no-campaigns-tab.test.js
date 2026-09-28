/**
 * no-campaigns-tab.test.js
 *
 * background.js used to open /drops/campaigns in a transient pinned tab
 * (refreshOpenCampaigns) every 45 minutes, on enable, on every watch-list
 * save and from a popup button - it got in the way of the user browsing
 * other campaigns and was removed in 0.6.14. The openCampaigns snapshot is
 * now passive only (written when the user has that page open themselves).
 * These tests drive every former trigger against a deliberately STALE
 * snapshot and assert no /drops/campaigns tab is ever created, and that
 * the passive path still stores a snapshot.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function makeSandbox() {
  const storageData = {
    enabled: true, autoWatchEnabled: true, tabQuota: 3,
    watchList: [{ input: "warframe", slug: "warframe" }],
    openCampaigns: { fetchedAt: Date.now() - 3 * 60 * 60 * 1000, bySlug: {} }, // stale on purpose
  };
  const created = [];
  const listeners = { alarm: [], changed: [], message: [] };
  let nextTabId = 1;

  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, URL: globalThis.URL, Blob: globalThis.Blob,
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
        onChanged: { addListener: (fn) => listeners.changed.push(fn) },
      },
      runtime: {
        onMessage: { addListener: (fn) => listeners.message.push(fn) },
        getManifest: () => ({ version: "0.0.0-test" }),
      },
      tabs: {
        create: (opts) => { created.push(opts); return Promise.resolve({ id: nextTabId++ }); },
        update: () => Promise.resolve(),
        remove: () => Promise.resolve(),
        get: () => Promise.reject(new Error("no such tab")),
        query: () => Promise.resolve([]),
        reload: () => {},
      },
      alarms: {
        create: () => {}, clear: () => Promise.resolve(true),
        onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
      },
      browserAction: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
      downloads: { download: () => Promise.resolve(1), search: () => Promise.resolve([]) },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext(read("background.js"), ctx);
  const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  return { ctx, storageData, created, listeners, flush };
}

const campaignTabs = (created) => created.filter((o) => /\/drops\/campaigns/.test(o.url || ""));

async function testNoFormerTriggerOpensTheCampaignsTab() {
  const { ctx, created, listeners, flush } = makeSandbox();

  await vm.runInContext("applyEnabledState", ctx)(true); // used to kick a refresh
  await flush();

  const reload = vm.runInContext("RELOAD_ALARM", ctx); // used to refresh every 45 min
  for (const fn of listeners.alarm) await fn({ name: reload });
  await flush();

  const newList = [{ input: "warframe", slug: "warframe" }, { input: "rust", slug: "rust" }];
  for (const fn of listeners.changed) await fn({ watchList: { oldValue: [], newValue: newList } }, "local"); // used to refresh on save
  await flush();

  // the popup's old "check All Campaigns now" message must be gone
  for (const fn of listeners.message) {
    const r = fn({ type: "refreshCampaigns" }, {});
    assert.ok(r === undefined, "refreshCampaigns is no longer a handled message");
  }
  await flush();

  assert.deepStrictEqual(campaignTabs(created), [], `campaigns tab opened: ${JSON.stringify(campaignTabs(created))}`);
  assert.strictEqual(vm.runInContext("typeof refreshOpenCampaigns", ctx), "undefined");
  assert.ok(created.length > 0, "sanity: the run did open other (watch/inventory) tabs, so the audit is meaningful");
  console.log(`  OK  enable / reload alarm / watch-list save / popup message: 0 campaigns tabs (${created.length} other tabs opened)`);
}

async function testPassiveSnapshotStillStored() {
  const { ctx, storageData, flush } = makeSandbox();
  const handle = vm.runInContext("handleGqlDropSignal", ctx);
  await handle({
    signal: { kind: "openCampaigns", snapshot: true, games: [
      { id: "1", name: "Warframe", active: true, endAt: Date.now() + 86_400_000, accountConnected: true },
    ] },
  }, { id: 7 });
  await flush();
  const oc = storageData.openCampaigns;
  assert.ok(oc && oc.bySlug && oc.bySlug.warframe && oc.bySlug.warframe.active, "snapshot from a user-opened page is stored");
  assert.ok(Date.now() - oc.fetchedAt < 5_000, "and marked fresh");
  console.log("  OK  a campaigns page the user opens still feeds the snapshot (passive path intact)");
}

(async () => {
  console.log("Running no-campaigns-tab tests (no real browser, no network)...\n");
  try {
    await testNoFormerTriggerOpensTheCampaignsTab();
    await testPassiveSnapshotStillStored();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    process.exit(1);
  }
})();
