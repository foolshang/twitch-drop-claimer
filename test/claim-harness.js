/**
 * claim-harness.js - shared fixtures for the claim tests (not a test itself):
 * a fake clock, ONE real background.js in a vm sandbox, and fake "tabs" (each
 * with its own fake DOM) running the real content.js against it.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const flush = () => new Promise((r) => setImmediate(r));

// ---- fake clock: Date.now + setTimeout driven by advanceTo() ----------------
function makeClock(start = 1_000_000_000_000) {
  const clock = { now: start, timers: [], nextId: 1 };
  clock.setTimeout = (fn, ms) => { const id = clock.nextId++; clock.timers.push({ id, at: clock.now + ms, fn }); return id; };
  clock.clearTimeout = (id) => { clock.timers = clock.timers.filter((t) => t.id !== id); };
  clock.advanceTo = (target) => {
    for (;;) {
      const due = clock.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock.timers = clock.timers.filter((t) => t !== due);
      clock.now = Math.max(clock.now, due.at);
      due.fn();
    }
    clock.now = target;
  };
  clock.FakeDate = function (...a) { return new Date(...a); };
  clock.FakeDate.now = () => clock.now;
  return clock;
}

// ---- the one real background.js ---------------------------------------------
async function makeBackground({ clock, session = {}, local = {} }) {
  const localData = { enabled: false, ...local }; // enabled:false -> boot does no scheduling of its own
  const store = (data) => ({
    get: (keys) => {
      if (keys == null) return Promise.resolve({ ...data });
      if (typeof keys === "string") return Promise.resolve({ [keys]: data[keys] });
      const out = {};
      for (const k of keys) out[k] = data[k];
      return Promise.resolve(out);
    },
    set: (o) => { Object.assign(data, o); return Promise.resolve(); },
  });
  const listeners = [];
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    Date: clock.FakeDate,
    setTimeout, clearTimeout, setInterval, clearInterval, // background's own timers: real ones, none matter here
    TextEncoder, URL: globalThis.URL, Blob: globalThis.Blob,
    browser: {
      storage: { local: store(localData), session: store(session), onChanged: { addListener: () => {} } },
      runtime: { onMessage: { addListener: (fn) => listeners.push(fn) }, getManifest: () => ({ version: "0.0.0-test" }) },
      windows: { get: () => Promise.reject(new Error("none")), getAll: () => Promise.resolve([]), create: () => Promise.reject(new Error("none")), remove: () => Promise.resolve() },
      tabs: { query: () => Promise.resolve([]), get: () => Promise.reject(new Error("none")), create: () => Promise.resolve({ id: 1 }), update: () => Promise.resolve(), remove: () => Promise.resolve(), reload: () => {} },
      alarms: { create: () => {}, clear: () => Promise.resolve(true), onAlarm: { addListener: () => {} } },
      browserAction: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
      downloads: { download: () => Promise.resolve(1), search: () => Promise.resolve([]) },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext(read("background.js"), ctx);
  await new Promise((r) => setTimeout(r, 100)); // boot: resetStateForNewBrowserSession & friends
  assert.strictEqual(listeners.length, 1, "background.js registered its message listener");
  return {
    local: localData, session, ctx,
    send: (msg, tabId = 1) => Promise.resolve(listeners[0](msg, { tab: { id: tabId } })),
    logLines: () => vm.runInContext("debugLogBuffer.slice()", ctx),
    entry: (key) => { const e = vm.runInContext(`claimBackoff && claimBackoff.get(${JSON.stringify(key)})`, ctx); return e ? { ...e } : e; },
  };
}

// ---- a fake tab: fake DOM + the real content.js, wired to the background ----
// The key background.js sees for the button claimButton(tab, reward) makes: the campaign id from
// the card's title link + the tier's reward name (content.js claimKey)
const K = (reward, campaignId = "cmp") => `${campaignId}:${reward}`;

function claimButton(tab, reward, { onClick, gameId, campaignId = "cmp", name } = {}) {
  const btn = {
    textContent: "Claim Now",
    disabled: false,
    clicks: 0,
    getAttribute: () => null,
    closest: () => null,
    click() { this.clicks++; tab.clickLog.push({ tab: tab.id, at: tab.clock.now, reward }); if (onClick) onClick(this); },
  };
  const rewardName = name === undefined ? reward : name; // name: null = a tier whose name cannot be read
  const p = { textContent: rewardName || "", querySelector: () => null };
  const link = { getAttribute: (n) => (n === "href" ? `/drops/campaigns?dropID=${campaignId}` : null), textContent: reward };
  const isButtons = (sel) => /button/.test(sel);
  // the tier: this one button and the reward's name (its icon's alt is the same generic text on every tier, as in the real DOM)
  const tier = {
    textContent: "100% of 1 hour",
    parentElement: null,
    querySelectorAll: (sel) => (isButtons(sel) ? [btn] : sel === "p" && rewardName ? [p] : []),
    querySelector: () => null,
  };
  // the card: the title link, the boxart, the tier
  const card = {
    parentElement: null,
    querySelectorAll: (sel) => (/dropID/.test(sel) ? [link] : isButtons(sel) ? [btn] : sel === "p" && rewardName ? [p] : []),
    querySelector: (sel) => {
      if (/dropID/.test(sel)) return link;
      if (gameId && sel === 'img[src*="_IGDB-"]') return { src: `https://static-cdn.jtvnw.net/ttv-boxart/${gameId}_IGDB-285x380.jpg` };
      return null;
    },
  };
  tier.parentElement = card;
  btn.parentElement = tier;
  tab.dom.buttons.push(btn);
  return btn;
}
const removeButton = (tab, btn) => { tab.dom.buttons = tab.dom.buttons.filter((b) => b !== btn); };

async function openTab({ clock, bg, id, clickLog = [], pathname = "/drops/inventory", gameIdMap = {} }) {
  const dom = { buttons: [] };
  const observers = [];
  const changeListeners = [];
  const sent = []; // every runtime.sendMessage payload
  const localSets = [];
  const myTimers = new Set();
  const messageListeners = [];
  const win = {
    location: { origin: "https://www.twitch.tv" },
    addEventListener: (type, fn) => { if (type === "message") messageListeners.push(fn); },
  };
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    Set, Map, Promise, URL, JSON, Math, Array, Object, Number, String, RegExp,
    Date: clock.FakeDate,
    window: win,
    location: { pathname, href: `https://www.twitch.tv${pathname}` },
    document: {
      body: {},
      querySelectorAll: (sel) => (sel === 'button, [role="button"]' ? dom.buttons : []),
      querySelector: () => null,
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
      disconnect() {}
    },
    setInterval: () => 1, clearInterval: () => {}, // scans are driven by hand through the observer callback
    setTimeout: (fn, ms) => { const t = clock.setTimeout(fn, ms); myTimers.add(t); return t; },
    clearTimeout: (t) => { myTimers.delete(t); clock.clearTimeout(t); },
    browser: {
      storage: {
        local: { get: () => Promise.resolve({ enabled: true, gameIdMap }), set: (o) => { localSets.push(o); return Promise.resolve(); } },
        onChanged: { addListener: (fn) => changeListeners.push(fn) },
      },
      runtime: {
        sendMessage: (m) => { sent.push(m); return bg.send(m, id); },
        onMessage: { addListener: () => {} },
      },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext(read("content.js"), ctx);
  await flush(); // storage.local.get(...).then(start)
  assert.strictEqual(observers.length, 1, "content.js started");
  return {
    id, clock, dom, sent, localSets, clickLog,
    scan: () => Promise.resolve(observers[0].cb([])),
    // what inject.js's postMessage would deliver to content.js (via the page's message event)
    postSignal: (operationName, signal) => messageListeners.forEach((fn) => fn({
      source: win, origin: win.location.origin,
      data: { type: "__DROP_CLAIMER_GQL__", payload: { operationName, signal: { ...signal, operationName }, at: clock.now } },
    })),
    setEnabled: (v) => changeListeners.forEach((fn) => fn({ enabled: { newValue: v, oldValue: !v } }, "local")),
    // the tab is gone: its timers never fire (a closed tab reports nothing)
    close() { for (const t of myTimers) clock.clearTimeout(t); myTimers.clear(); },
    results: () => sent.filter((m) => m.type === "claimResult"),
  };
}

// one scan per second (all tabs at the same instant) for `ms`, firing due timers and letting messages settle
async function run(tabs, ms, everyMs = SEC) {
  const clock = tabs[0].clock;
  const end = clock.now + ms;
  while (clock.now < end) {
    clock.advanceTo(Math.min(clock.now + everyMs, end));
    await flush(); // verdict messages sent by timers just fired
    await Promise.all(tabs.map((t) => t.scan()));
    await flush();
  }
}


module.exports = { SEC, MIN, HOUR, flush, read, makeClock, makeBackground, claimButton, removeButton, openTab, run, K };
