/**
 * inventory-reload.test.js
 *
 * Real report (0.6.23): the @Blooprint and @GEEGA rows stayed at 0/1 until the user refreshed the
 * inventory page by hand, then showed "1/1 done" at once - the done logic was fine, the inventory
 * data was stale because the extension's own inventory tab was never reloaded. Both reload paths
 * (the 15-minute alarm and the "a drop was claimed" refresh) skipped any tab that was `active`, to
 * leave the user's own foreground inventory page alone - but the extension's inventory tab sits in
 * the watch window, where it can be that window's active (selected) tab, so it was skipped for good.
 * Now only an active tab that is NOT in the extension's own (tagged) window is left alone.
 *
 * Real background.js, fake windows/sessions/tabs.
 */

const vm = require("vm");
const assert = require("assert");
const { flush, makeClock, makeBackground } = require("./claim-harness");
const { attachWindowApis } = require("./window-stubs");

const WATCH_WINDOW = 100;
const USER_WINDOW = 200;

async function world(tabs) {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const reloads = [];
  const api = attachWindowApis(bg.ctx.browser, {});
  api.wins.set(WATCH_WINDOW, { id: WATCH_WINDOW, type: "normal" });
  api.wins.set(USER_WINDOW, { id: USER_WINDOW, type: "normal" });
  api.tag(WATCH_WINDOW); // the extension's own window, as tagged when it was created
  Object.assign(bg.ctx, { __tabs: tabs, __reloads: reloads });
  vm.runInContext(`
    browser.tabs.query = async () => __tabs;
    browser.tabs.reload = (id) => { __reloads.push(id); return Promise.resolve(); };
  `, bg.ctx);
  return { bg, reloads };
}

const tab = (id, windowId, active) => ({ id, windowId, active, url: "https://www.twitch.tv/drops/inventory" });

async function testTheExtensionsOwnActiveInventoryTabIsReloaded() {
  // the inventory tab is the selected tab of the watch window (nobody looks at it)
  const a = await world([tab(38, WATCH_WINDOW, true)]);
  await vm.runInContext("handleDropClaimed()", a.bg.ctx); // a drop was claimed: refresh
  assert.deepStrictEqual(a.reloads, [38], "'a drop was claimed' refresh reloads it even though it is the window's active tab");

  const b = await world([tab(38, WATCH_WINDOW, true)]);
  const r = await vm.runInContext("reloadInventoryTabs(true)", b.bg.ctx); // the 15-minute alarm
  assert.deepStrictEqual(b.reloads, [38], "the periodic reload too");
  assert.ok(b.bg.logLines().some((l) => /reloaded inventory tab 38 \(the active tab of the watch window\)/.test(l)), "and says so");
  assert.strictEqual(r.found, 1);
  console.log("  OK  the extension's own inventory tab is reloaded even when it is its window's active tab (both paths)");
}

async function testTheUsersOwnForegroundInventoryPageIsLeftAlone() {
  const w = await world([tab(51, USER_WINDOW, true)]);
  await vm.runInContext("handleDropClaimed()", w.bg.ctx);
  const r = await vm.runInContext("reloadInventoryTabs(true)", w.bg.ctx);
  assert.deepStrictEqual(w.reloads, [], "the active tab of the user's window is never reloaded under them");
  assert.strictEqual(r.found, 1, "(and it counts as an open inventory tab: none is opened next to it)");
  console.log("  OK  the user's own active inventory tab is left alone");
}

async function testInactiveTabsAreReloadedAsBefore() {
  const w = await world([tab(60, USER_WINDOW, false), tab(38, WATCH_WINDOW, false), tab(51, USER_WINDOW, true)]);
  const r = await vm.runInContext("reloadInventoryTabs(true)", w.bg.ctx);
  assert.deepStrictEqual(w.reloads.sort(), [38, 60], "inactive tabs as before; the user's active one not");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.reloaded)).sort(), [38, 60]);
  console.log("  OK  inactive inventory tabs are reloaded as before");
}

(async () => {
  console.log("Running inventory reload tests (real background.js)...\n");
  try {
    await testTheExtensionsOwnActiveInventoryTabIsReloaded();
    await testTheUsersOwnForegroundInventoryPageIsLeftAlone();
    await testInactiveTabsAreReloadedAsBefore();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
