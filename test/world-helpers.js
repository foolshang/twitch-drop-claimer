/**
 * world-helpers.js - fixtures for the review tests (not a test itself):
 *  - makeWorld(): the real background.js in a vm sandbox with an in-memory tabs registry, a fake clock
 *    (Date) and optional slow tab creation;
 *  - openDomTab(): the real content.js on a jsdom page wired to a background (claim-harness makeBackground),
 *    recording the timers it registers so a test can see which are alive.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { flush } = require("./claim-harness");

const ROOT = path.join(__dirname, "..");
const readFile = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function makeWorld(storage = {}, { createDelay = 0 } = {}) {
  const storageData = { autoWatchEnabled: true, tabQuota: 2, openCampaigns: { fetchedAt: Date.now(), bySlug: {} }, ...storage };
  const listeners = [];
  const removedListeners = [];
  const tabsById = new Map();
  let nextTabId = 1;
  let nowMs = Date.now();
  const FakeDate = function (...a) { return a.length ? new Date(...a) : new Date(nowMs); };
  FakeDate.now = () => nowMs;
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    Date: FakeDate,
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
        create: async (opts) => {
          if (createDelay) await new Promise((r) => setTimeout(r, createDelay));
          const id = nextTabId++;
          tabsById.set(id, { url: opts.url, windowId: opts.windowId });
          return { id };
        },
        update: () => Promise.resolve(),
        remove: (id) => (tabsById.delete(id) ? Promise.resolve() : Promise.reject(new Error("no such tab"))),
        get: (id) => (tabsById.has(id) ? Promise.resolve({ id, ...tabsById.get(id) }) : Promise.reject(new Error("no such tab"))),
        query: () => Promise.resolve([]),
        reload: () => {},
        onRemoved: { addListener: (fn) => removedListeners.push(fn) },
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
  const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
  return {
    ctx, storageData, listeners, removedListeners, tabsById, wait,
    advance(ms) { nowMs += ms; },
    tabs: () => Object.keys(storageData.watchTabs || {}).sort(),
    logs: () => vm.runInContext("debugLogBuffer.slice()", ctx),
    async boot() {
      vm.runInContext(readFile("shared.js"), ctx);
      vm.runInContext(readFile("i18n.js"), ctx);
      vm.runInContext(readFile("background.js"), ctx);
      await wait(100);
    },
    tick() { return vm.runInContext("serialized(autoWatchTick)", ctx); },
    async settledTick() { await vm.runInContext("serialized(autoWatchTick)", ctx); await wait(); },
    send: (msg, tabId) => Promise.resolve(listeners[0](msg, { tab: { id: tabId } })),
  };
}

// content.js on a jsdom page; `bg` is a claim-harness background (bg.send)
async function openDomTab({ clock, bg, html, pathname = "/drops/inventory", search = "", local = {} }) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: `https://www.twitch.tv${pathname}${search}` });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  const observers = [];
  const sent = [];
  const localSets = [];
  const intervals = []; // { fn, ms, cleared }
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    Set, Map, WeakMap, Promise, URL, URLSearchParams, JSON, Math, Array, Object, Number, String, RegExp,
    Date: clock.FakeDate,
    window, document: window.document, location: window.location, history: window.history,
    MutationObserver: class { constructor(cb) { this.cb = cb; this.alive = true; observers.push(this); } observe() {} disconnect() { this.alive = false; } },
    setInterval: (fn, ms) => { intervals.push({ fn, ms, cleared: false }); return intervals.length; },
    clearInterval: (id) => { if (intervals[id - 1]) intervals[id - 1].cleared = true; },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (t) => clock.clearTimeout(t),
    browser: {
      storage: { local: { get: () => Promise.resolve({ enabled: true, gameIdMap: {}, ...local }), set: (o) => { localSets.push(o); return Promise.resolve(); } }, onChanged: { addListener() {} } },
      runtime: { sendMessage: (m) => { sent.push(m); return bg.send(m, 1); }, onMessage: { addListener() {} } },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFile("shared.js"), ctx);
  vm.runInContext(readFile("i18n.js"), ctx);
  vm.runInContext(readFile("content.js"), ctx);
  await flush();
  const clicked = [];
  window.document.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) clicked.push(b.getAttribute("data-test") || b.getAttribute("aria-label") || b.textContent.trim()); }, true);
  return {
    window, sent, localSets, clicked, clock, intervals, ctx,
    liveObservers: () => observers.filter((o) => o.alive).length,
    scan: () => Promise.all(observers.filter((o) => o.alive).map((o) => o.cb([]))).then(() => flush()),
    navigate: (to) => window.history.pushState({}, "", to),
    asks: () => sent.filter((m) => m.type === "claimAsk").map((m) => m.key),
    results: () => sent.filter((m) => m.type === "claimResult"),
  };
}

module.exports = { makeWorld, openDomTab, readFile };
