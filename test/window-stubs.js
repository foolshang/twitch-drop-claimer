/**
 * window-stubs.js - fixtures for the tests that load background.js (not a test).
 *
 * Since 0.6.19 background.js never opens a tab without a verified watch window
 * ("window 2", tagged with sessions.setWindowValue): no browser.windows /
 * browser.sessions means no tabs at all. attachWindowApis() gives a sandbox's
 * `browser` a small fake of both:
 *   - windows.create() makes a window (and its initial blank tab through the
 *     sandbox's own tabs registry via hooks.createTab, so tab counts keep
 *     meaning what they meant), windows.get/getAll/remove behave;
 *   - sessions.setWindowValue/getWindowValue keep tags per window, the way
 *     Firefox's session store does (survives "restore": the same Map is reused
 *     by tests that model one);
 *   - onCreated/onRemoved listeners are recorded so a test can fire them.
 */

function attachWindowApis(browserObj, hooks = {}) {
  const wins = new Map(); // id -> { id, type, focused }
  const tags = new Map(); // `${windowId}:${key}` -> value
  const listeners = { created: [], removed: [] };
  let nextWin = hooks.firstWindowId || 100;
  const tabsIn = hooks.tabsIn || (() => []);

  const api = {
    wins, tags, listeners,
    addWindow(extra = {}) { const id = nextWin++; wins.set(id, { id, type: "normal", focused: false, ...extra }); return id; },
    tag(id, key = "dropClaimerWatch", value = true) { tags.set(`${id}:${key}`, value); },
    fireCreated(win) { listeners.created.forEach((fn) => fn(win)); },
  };

  browserObj.windows = {
    get: (id) => (wins.has(id) ? Promise.resolve({ ...wins.get(id) }) : Promise.reject(new Error("no such window"))),
    getAll: (opts = {}) => Promise.resolve([...wins.values()].map((w) => ({
      ...w,
      ...(opts.populate ? { tabs: tabsIn(w.id) } : {}),
    }))),
    create: async () => {
      const id = api.addWindow({ focused: true });
      let tab = null;
      if (hooks.createTab) tab = await hooks.createTab({ url: "about:blank", windowId: id });
      return { id, type: "normal", tabs: tab ? [{ ...tab, windowId: id }] : [] };
    },
    remove: (id) => {
      if (!wins.has(id)) return Promise.reject(new Error("no such window"));
      wins.delete(id);
      listeners.removed.forEach((fn) => fn(id));
      return Promise.resolve();
    },
    onCreated: { addListener: (fn) => listeners.created.push(fn) },
    onRemoved: { addListener: (fn) => listeners.removed.push(fn) },
  };
  browserObj.sessions = {
    setWindowValue: (id, key, value) => { tags.set(`${id}:${key}`, value); return Promise.resolve(); },
    getWindowValue: (id, key) => Promise.resolve(tags.get(`${id}:${key}`)),
  };
  return api;
}

module.exports = { attachWindowApis };
