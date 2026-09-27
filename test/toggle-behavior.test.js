/**
 * toggle-behavior.test.js
 *
 * Loads the real content.js / background.js source into a sandboxed vm
 * context with stubbed WebExtension + DOM APIs, then exercises the
 * enabled-toggle behavior directly against that code (no real browser).
 *
 * Covers two of the three checks from the verification checklist that can
 * genuinely be automated without a live, logged-in Twitch session:
 *
 *   1. No tab/alarm activity after OFF - this extension never calls
 *      fetch()/XHR itself; every "request" it causes is tabs.create/
 *      reload/update triggered by an alarm or by content-script navigation.
 *      So "no network request after OFF" reduces to: alarms are cleared,
 *      and even a racing alarm fire is rejected by the code's own guard.
 *   2. No leaked timers/observers across many rapid ON/OFF cycles - tracked
 *      via real Node timer ids in a Set (added on create, removed on
 *      clear/natural fire), so a bug in the running-guard or in stop()
 *      would show up as the set's size growing or failing to reach zero.
 *
 * NOT covered here (needs a live, logged-in twitch.tv session with an
 * active Drops campaign, which this environment cannot provide):
 *   - storage.local persisting across an actual Firefox restart (this is a
 *     Firefox platform guarantee, not our code - see run summary for why
 *     this wasn't re-verified with a live browser relaunch)
 *   - the auto-watch directory/channel picking, quality/mute clicks, and
 *     inventory progress parsing against Twitch's real DOM
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function makeSandbox({ pathname }) {
  const state = {
    liveIntervals: new Set(),
    liveTimeouts: new Set(),
    liveObservers: 0,
    tabsCreate: 0,
    tabsReload: 0,
    tabsUpdate: 0,
    tabsRemove: 0,
    liveAlarms: new Set(),
    alarmListeners: [],
  };

  const storageData = {};
  const changeListeners = [];

  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;

  let nextTabId = 1;

  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} }, // silence [DropClaimer] noise
    Set,
    Map,
    Promise,
    URL,
    document: {
      body: {},
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    location: { pathname, href: `https://www.twitch.tv${pathname}` },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; this._connected = false; }
      observe() { if (!this._connected) { this._connected = true; state.liveObservers++; } }
      disconnect() { if (this._connected) { this._connected = false; state.liveObservers--; } }
    },
    setInterval: (fn, ms) => {
      const id = realSetInterval(fn, ms);
      state.liveIntervals.add(id);
      return id;
    },
    clearInterval: (id) => {
      state.liveIntervals.delete(id);
      realClearInterval(id);
    },
    setTimeout: (fn, ms) => {
      const id = realSetTimeout(() => { state.liveTimeouts.delete(id); fn(); }, ms);
      state.liveTimeouts.add(id);
      return id;
    },
    clearTimeout: (id) => {
      state.liveTimeouts.delete(id);
      realClearTimeout(id);
    },
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
      runtime: {
        sendMessage: () => Promise.resolve(),
        onMessage: { addListener: () => {} },
        getManifest: () => ({ version: "0.0.0-test" }),
      },
      tabs: {
        create: () => { state.tabsCreate++; return Promise.resolve({ id: nextTabId++ }); },
        query: () => Promise.resolve([]),
        reload: () => { state.tabsReload++; },
        update: () => { state.tabsUpdate++; return Promise.resolve(); },
        remove: () => { state.tabsRemove++; return Promise.resolve(); },
        get: () => Promise.reject(new Error("no such tab")),
      },
      alarms: {
        create: (name) => { state.liveAlarms.add(name); },
        clear: (name) => { state.liveAlarms.delete(name); return Promise.resolve(true); },
        onAlarm: { addListener: (fn) => state.alarmListeners.push(fn) },
      },
      browserAction: {
        setBadgeText: () => {},
        setBadgeBackgroundColor: () => {},
        setTitle: () => {},
      },
      downloads: {
        download: () => Promise.resolve(1),
        search: () => Promise.resolve([{ state: "complete", filename: "TEST/twitch-drop-claimer-debug.log" }]),
      },
    },
    URL: globalThis.URL,
    Blob: globalThis.Blob,
  };

  const ctx = vm.createContext(sandbox);

  function setEnabled(value, oldValue) {
    storageData.enabled = value;
    for (const fn of changeListeners) fn({ enabled: { newValue: value, oldValue } }, "local");
  }

  function flush(ms = 15) {
    return new Promise((resolve) => realSetTimeout(resolve, ms));
  }

  return { ctx, state, storageData, setEnabled, flush };
}

async function testContentLeak(pathname) {
  const { ctx, state, setEnabled, flush } = makeSandbox({ pathname });
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext('browser.storage.local.set({ enabled: true });', ctx);
  vm.runInContext(read("content.js"), ctx);

  await flush(); // let the initial async storage.local.get(...).then(start()) run

  for (let i = 0; i < 50; i++) {
    setEnabled(false, true);
    setEnabled(true, false);
  }
  await flush();

  const midCycleIntervals = state.liveIntervals.size;
  assert.ok(midCycleIntervals > 0, `[${pathname}] expected at least one live interval while ON`);

  setEnabled(false, true); // end OFF
  await flush();

  assert.strictEqual(state.liveObservers, 0, `[${pathname}] MutationObserver leaked after OFF`);
  assert.strictEqual(state.liveIntervals.size, 0, `[${pathname}] setInterval leaked after OFF (${state.liveIntervals.size} still live)`);
  assert.strictEqual(state.liveTimeouts.size, 0, `[${pathname}] setTimeout leaked after OFF (${state.liveTimeouts.size} still live)`);

  console.log(`  OK  content.js leak check [${pathname}]  (peak live intervals while ON: ${midCycleIntervals})`);
}

async function testBackgroundNoActivityAfterOff() {
  const { ctx, state, setEnabled, flush } = makeSandbox({ pathname: "/" });
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext('browser.storage.local.set({ enabled: true });', ctx);
  vm.runInContext(read("background.js"), ctx);

  await flush(30);
  assert.ok(state.liveAlarms.size >= 3, `expected reload/auto-off/auto-watch alarms to be created (got ${state.liveAlarms.size})`);

  setEnabled(false, true);
  await flush(30);

  assert.strictEqual(state.liveAlarms.size, 0, `alarms not cleared after OFF (still live: ${[...state.liveAlarms]})`);

  const before = { ...state, tabsCreate: state.tabsCreate, tabsReload: state.tabsReload, tabsUpdate: state.tabsUpdate };

  // simulate a racing alarm firing right after clear() - the handler's own
  // "if (!cfg.enabled) return" guard must reject it
  for (const fn of state.alarmListeners) {
    await fn({ name: "reload-inventory" });
    await fn({ name: "auto-off-check" });
    await fn({ name: "auto-watch-tick" });
  }
  await flush(30);

  assert.strictEqual(state.tabsCreate, before.tabsCreate, "tabs.create fired from a racing alarm after OFF");
  assert.strictEqual(state.tabsReload, before.tabsReload, "tabs.reload fired from a racing alarm after OFF");
  assert.strictEqual(state.tabsUpdate, before.tabsUpdate, "tabs.update fired from a racing alarm after OFF");

  console.log("  OK  background.js: alarms cleared + racing-alarm guard holds after OFF");
}

async function testFreshLoadRespectsStoredDisabled() {
  // a fresh page load where storage already says enabled:false must never start()
  const { ctx, state, flush } = makeSandbox({ pathname: "/drops/inventory" });
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext('browser.storage.local.set({ enabled: false });', ctx);
  vm.runInContext(read("content.js"), ctx);

  await flush(30);

  assert.strictEqual(state.liveObservers, 0, "observer started despite enabled:false in storage");
  assert.strictEqual(state.liveIntervals.size, 0, "interval started despite enabled:false in storage");

  console.log("  OK  content.js: fresh load with enabled:false in storage never starts (covers the restart-persistence contract on our side)");
}

(async () => {
  console.log("Running toggle-behavior tests (no real browser, no network)...\n");
  try {
    await testContentLeak("/drops/inventory");
    await testContentLeak("/some_channel");
    await testContentLeak("/directory/category/path-of-exile-2");
    await testBackgroundNoActivityAfterOff();
    await testFreshLoadRespectsStoredDisabled();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    process.exit(1);
  }
})();
