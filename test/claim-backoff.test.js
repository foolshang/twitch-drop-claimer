/**
 * claim-backoff.test.js
 *
 * Seen live (2026-09-30): Twitch answered every DropsPage_ClaimDropRewards with
 * "failed integrity check", the four "Claim Now" buttons on the inventory just
 * stayed, and content.js re-clicked them every few seconds (each click also
 * told background.js to reload the inventory tab) - dozens of rejected claims
 * in a few minutes. Now, for every claim button:
 *   - content.js asks background.js (`claimAsk`) before clicking; background
 *     says no while the reward is backing off / given up for the session /
 *     held by another tab, so of several tabs looking at the same button only
 *     one clicks per round;
 *   - CLAIM_VERIFY_MS after a click the tab judges the claim (no claim button
 *     for that reward left = claimed) and reports it (`claimResult`);
 *     background.js keeps the failure count and next-allowed time per reward:
 *     1 -> 5 -> 15 min, given up after 4 failures in a row;
 *   - that state belongs to background.js, not to a tab: closing and reopening
 *     the inventory does not reset it; a new browser session does.
 *
 * Real content.js / background.js / shared.js in vm sandboxes: several fake
 * "tabs" (fake DOM each) talking to ONE real background, on a fake clock. No
 * browser, no network, no Twitch session.
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
function claimButton(tab, reward, { onClick } = {}) {
  const btn = {
    textContent: "Claim Now",
    disabled: false,
    clicks: 0,
    getAttribute: () => null,
    click() { this.clicks++; tab.clickLog.push({ tab: tab.id, at: tab.clock.now, reward }); if (onClick) onClick(this); },
  };
  btn.parentElement = { // the reward's card: this one button + the reward image
    parentElement: null,
    querySelectorAll: () => [btn],
    querySelector: (sel) => (sel === "img[alt]" ? { getAttribute: () => reward } : null),
  };
  tab.dom.buttons.push(btn);
  return btn;
}
const removeButton = (tab, btn) => { tab.dom.buttons = tab.dom.buttons.filter((b) => b !== btn); };

async function openTab({ clock, bg, id, clickLog = [], pathname = "/drops/inventory" }) {
  const dom = { buttons: [] };
  const observers = [];
  const changeListeners = [];
  const sent = []; // every runtime.sendMessage payload
  const localSets = [];
  const myTimers = new Set();
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    Set, Map, Promise, URL, JSON, Math, Array, Object, Number, String, RegExp,
    Date: clock.FakeDate,
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
        local: { get: () => Promise.resolve({ enabled: true }), set: (o) => { localSets.push(o); return Promise.resolve(); } },
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

const within = (gap, min) => gap >= min && gap <= min + 5; // + up to 5 s of scan throttle
const rel = (log, t0) => log.map((c) => (c.at - t0) / SEC);

async function testUnclaimableButtonFollowsTheSchedule() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const tab = await openTab({ clock, bg, id: 1 });
  const t0 = clock.now;
  const btn = claimButton(tab, "Rust Isles Boots"); // never goes away: Twitch rejects the claim
  await tab.scan(); // t = 0
  await flush();
  await run([tab], 4 * HOUR);

  const times = rel(tab.clickLog, t0);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.strictEqual(btn.clicks, 4, `4 attempts (CLAIM_MAX_FAILURES) and then never again - got ${btn.clicks} clicks, the first at ${times.slice(0, 6).join(", ")} s`);
  // gap = CLAIM_VERIFY_MS + the backoff step
  assert.ok(within(gaps[0], 12 + 60), `1st retry after 1 min: gap ${gaps[0]} s`);
  assert.ok(within(gaps[1], 12 + 300), `2nd retry after 5 min: gap ${gaps[1]} s`);
  assert.ok(within(gaps[2], 12 + 900), `3rd retry after 15 min: gap ${gaps[2]} s`);
  assert.deepStrictEqual(tab.results().map((m) => m.ok), [false, false, false, false]);
  assert.ok(!tab.sent.some((m) => m.type === "dropClaimed"), "a rejected claim never asks for an inventory reload");
  assert.ok(!tab.localSets.some((o) => o.lastClaimAt), "and is never recorded as the last claim");
  assert.deepStrictEqual({ ...bg.entry("Rust Isles Boots") }, { f: 4, next: 0, stop: true }, "background gave up on the reward");
  console.log(`  OK  unclaimable button: clicks at ${times.join(", ")} s (1 -> 5 -> 15 min), given up after 4 failures`);
}

async function testThreeTabsOnlyOneClicksPerRound() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const clickLog = [];
  const tabs = [];
  for (const id of [1, 2, 3]) {
    const tab = await openTab({ clock, bg, id, clickLog });
    claimButton(tab, "Rust Isles Boots"); // all three tabs see the same never-claimable button
    tabs.push(tab);
  }
  const t0 = clock.now;
  await Promise.all(tabs.map((t) => t.scan())); // the same instant
  await flush();
  assert.strictEqual(clickLog.length, 1, "three tabs, one instant: exactly one click");

  await run(tabs, 4 * HOUR);
  const times = rel(clickLog, t0);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  assert.strictEqual(clickLog.length, 4, `one click per backoff round, 4 rounds in all - got ${clickLog.length} at ${times.slice(0, 8).join(", ")} s`);
  assert.ok(within(gaps[0], 12 + 60) && within(gaps[1], 12 + 300) && within(gaps[2], 12 + 900), `the same schedule as with one tab: gaps ${gaps.join(", ")}`);
  const verdicts = tabs.reduce((n, t) => n + t.results().length, 0);
  assert.strictEqual(verdicts, 4, "and one verdict per round, from whichever tab clicked");
  assert.strictEqual(bg.entry("Rust Isles Boots").f, 4);
  console.log(`  OK  3 tabs, one button: one click per round (clicks at ${times.join(", ")} s, from tabs ${clickLog.map((c) => c.tab).join(",")})`);
}

async function testClosingAndReopeningTheInventoryKeepsTheCount() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const clickLog = [];
  const t0 = clock.now;

  const first = await openTab({ clock, bg, id: 1, clickLog });
  claimButton(first, "Boots");
  await first.scan();
  await flush();
  await run([first], 100 * SEC); // clicks at 0 and ~75 s, both rejected (second verdict at ~87 s)
  assert.strictEqual(bg.entry("Boots").f, 2, "two rejections recorded");
  assert.strictEqual(clickLog.length, 2);

  first.close(); // the user closes the inventory tab
  const second = await openTab({ clock, bg, id: 7, clickLog }); // ...and opens it again: a brand-new content script
  claimButton(second, "Boots");
  await run([second], 200 * SEC); // still inside the 5 min wait after the 2nd failure (until ~387 s)
  assert.strictEqual(clickLog.length, 2, "the reopened tab does not click before the recorded wait is over");

  await run([second], 4 * HOUR);
  const times = rel(clickLog, t0);
  assert.strictEqual(clickLog.length, 4, `it carried on counting: 4 attempts in all, not 4 more - clicks at ${times.join(", ")} s`);
  assert.deepStrictEqual(clickLog.map((c) => c.tab), [1, 1, 7, 7]);
  assert.ok(within(times[2] - times[1], 12 + 300), `3rd attempt after the 5 min step: ${times[2] - times[1]} s`);
  assert.ok(within(times[3] - times[2], 12 + 900), `4th after the 15 min step: ${times[3] - times[2]} s`);
  assert.strictEqual(bg.entry("Boots").stop, true);
  console.log(`  OK  closing/reopening the inventory tab keeps the count (clicks at ${times.join(", ")} s)`);
}

async function testASuccessfulClaimIsRecordedAndForgotten() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const tab = await openTab({ clock, bg, id: 1 });
  const btn = claimButton(tab, "Boots", { onClick: (b) => removeButton(tab, b) }); // vanishes after the click, as after a real claim
  await tab.scan();
  await flush();
  await run([tab], 20 * SEC);
  assert.strictEqual(btn.clicks, 1);
  assert.deepStrictEqual(tab.results().map((m) => [m.key, m.ok]), [["Boots", true]]);
  assert.ok(tab.localSets.some((o) => o.lastClaimAt && o.lastClaimText === "Claim Now"), "recorded as the last claim only now, after the verdict");
  assert.ok(tab.sent.some((m) => m.type === "dropClaimed"), "and only now is the inventory refresh requested");
  assert.strictEqual(bg.entry("Boots"), undefined, "background keeps nothing for a reward that went through");

  const again = claimButton(tab, "Boots"); // the same reward showing up again (next campaign)
  await run([tab], 6 * SEC);
  assert.strictEqual(again.clicks, 1, "clicked at once - nothing holds it back");
  console.log("  OK  a claim that goes through is recorded after the verdict and leaves no backoff behind");
}

async function testRewardsBackOffIndependently() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const tab = await openTab({ clock, bg, id: 1 });
  const stuck = claimButton(tab, "Rejected reward");
  claimButton(tab, "Fine reward", { onClick: (b) => removeButton(tab, b) });
  await tab.scan();
  await flush();
  await run([tab], 20 * SEC);
  assert.deepStrictEqual(tab.results().map((m) => [m.key, m.ok]).sort(), [["Fine reward", true], ["Rejected reward", false]]);
  const before = stuck.clicks;
  const fresh = claimButton(tab, "Third reward");
  await run([tab], 10 * SEC);
  assert.strictEqual(fresh.clicks, 1, "a different reward is claimed while another is backing off");
  assert.strictEqual(stuck.clicks, before, "the rejected one is left alone");
  console.log("  OK  backoff is per reward: one rejected reward does not hold up the others");
}

async function testATabThatDiesHoldsTheRewardOnlyBriefly() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const clickLog = [];
  const t0 = clock.now;
  const dying = await openTab({ clock, bg, id: 1, clickLog });
  claimButton(dying, "Boots");
  await dying.scan();
  await flush();
  assert.strictEqual(clickLog.length, 1);
  dying.close(); // closed before its verdict: reports nothing

  const other = await openTab({ clock, bg, id: 2, clickLog });
  claimButton(other, "Boots");
  await run([other], 50 * SEC);
  assert.strictEqual(clickLog.length, 1, "while the first tab may still be about to report, nobody else clicks");
  await run([other], 30 * SEC);
  const t = rel(clickLog, t0)[1];
  assert.ok(t >= 60 && t <= 66, `after CLAIM_INFLIGHT_TTL_MS (60 s) the reward is free again: second click at ${t} s`);
  assert.strictEqual((bg.entry("Boots") || {}).f || 0, other.results().length, "the dead tab cost no failure: only verdicts that were reported count");
  assert.strictEqual(dying.results().length, 0);
  console.log("  OK  a tab that dies before its verdict holds the reward for at most 60 s and costs no failure");
}

async function testSwitchingOffReleasesTheReward() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const clickLog = [];
  const a = await openTab({ clock, bg, id: 1, clickLog });
  claimButton(a, "Boots");
  await a.scan();
  await flush();
  a.setEnabled(false); // pending verdict cancelled -> the hold is released
  await flush();
  const b = await openTab({ clock, bg, id: 2, clickLog });
  claimButton(b, "Boots");
  await run([b], 8 * SEC);
  assert.strictEqual(a.results().length, 0, "no verdict (and no failure) from the tab that was switched off");
  assert.strictEqual(clickLog.length, 2, "another tab can claim it at once");
  assert.ok(!bg.entry("Boots") || !bg.entry("Boots").f, "and switching off cost no failure");
  console.log("  OK  switching a tab off cancels its verdict and releases the reward to other tabs");
}

async function testBackgroundStateOutlivesTheBackgroundPageAndDiesWithTheSession() {
  const clock = makeClock();
  const session = { tdcSessionStarted: 1 }; // storage.session as Firefox keeps it for the whole browser session
  const bg1 = await makeBackground({ clock, session });
  const tab1 = await openTab({ clock, bg: bg1, id: 1 });
  claimButton(tab1, "Boots");
  await tab1.scan();
  await flush();
  await run([tab1], 20 * SEC);
  assert.strictEqual(bg1.entry("Boots").f, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(session.claimBackoff)), { Boots: { f: 1, next: bg1.entry("Boots").next, stop: false } }, "mirrored into storage.session (without the in-memory hold)");

  // extension reloaded inside the same browser session: a new background page reads it back
  const bg2 = await makeBackground({ clock, session });
  assert.strictEqual((await bg2.send({ type: "claimAsk", key: "Boots" })).allowed, false, "still backing off after a background reload");
  clock.advanceTo(bg2.entry("Boots").next);
  assert.strictEqual((await bg2.send({ type: "claimAsk", key: "Boots" })).allowed, true, "and free when the wait is over");

  // Firefox starts a new browser session: no session marker -> everything is forgotten
  const stale = { claimBackoff: { Boots: { f: 3, next: clock.now + HOUR, stop: false } } };
  const bg3 = await makeBackground({ clock, session: stale, local: { claimHealth: { streak: 5, stopped: ["Boots"] } } });
  assert.strictEqual((await bg3.send({ type: "claimAsk", key: "Boots" })).allowed, true, "a new browser session starts clean");
  assert.strictEqual(bg3.local.claimHealth, null, "and the popup warning is gone");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(stale.claimBackoff)), {}, "storage.session mirror cleared too");
  console.log("  OK  state survives a background reload (storage.session) and is reset by a new browser session");
}

async function testBackgroundKeepsTheStreakAndLogsTheReason() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const ask = async (key) => { assert.strictEqual((await bg.send({ type: "claimAsk", key })).allowed, true, `${key} may be claimed`); };
  const fail = async (key) => { await bg.send({ type: "claimResult", key, ok: false }); };

  await ask("Boots"); await fail("Boots");
  clock.advanceTo(clock.now + 2 * MIN);
  await ask("Boots"); await fail("Boots");
  assert.strictEqual(bg.local.claimHealth.streak, 2);
  await ask("Other"); await fail("Other");
  assert.strictEqual(bg.local.claimHealth.streak, 3, "the streak counts rejected claims across rewards");
  clock.advanceTo(clock.now + 6 * MIN);
  await ask("Boots"); await fail("Boots");
  clock.advanceTo(clock.now + 16 * MIN);
  await ask("Boots"); await fail("Boots");
  assert.strictEqual(bg.local.claimHealth.streak, 5);
  assert.deepStrictEqual([...bg.local.claimHealth.stopped], ["Boots"]);
  assert.ok(bg.local.claimHealth.lastFailureAt > 0);

  const lines = bg.logLines().join("\n");
  assert.ok(/claim rejected, likely integrity - backing off 1 min for "Boots" \(failure 1\/4\)/.test(lines), "clear log line with the reason and the wait: " + lines);
  assert.ok(/backing off 5 min for "Boots" \(failure 2\/4\)/.test(lines));
  assert.ok(/backing off 15 min for "Boots" \(failure 3\/4\)/.test(lines));
  assert.ok(/claim rejected 4 times in a row, likely integrity - not retrying "Boots" this session/.test(lines));
  assert.strictEqual((await bg.send({ type: "claimAsk", key: "Boots" })).allowed, false, "given up: no more attempts this session");

  await ask("Fresh"); await bg.send({ type: "claimResult", key: "Fresh", ok: true });
  assert.strictEqual(bg.local.claimHealth.streak, 0, "one claim that goes through ends the streak (and the warning)");
  console.log("  OK  background: streak across rewards, given-up list, clear log lines, reset on success");
}

function testScheduleHelpersAndPopupWiring() {
  const ctx = vm.createContext({});
  vm.runInContext(read("shared.js"), ctx);
  assert.strictEqual(vm.runInContext("CLAIM_VERIFY_MS", ctx), 12 * SEC);
  assert.deepStrictEqual([...vm.runInContext("CLAIM_BACKOFF_MS", ctx)], [MIN, 5 * MIN, 15 * MIN], "1 -> 5 -> 15 min, no 60 min step");
  assert.strictEqual(vm.runInContext("CLAIM_MAX_FAILURES", ctx), 4);
  const step = vm.runInContext("(s, n) => claimBackoffAfterFailure(s, n)", ctx);
  let s = null;
  s = step(s, 1000); assert.deepStrictEqual({ ...s }, { f: 1, next: 1000 + MIN, stop: false });
  s = step(s, 2000); assert.deepStrictEqual({ ...s }, { f: 2, next: 2000 + 5 * MIN, stop: false });
  s = step(s, 3000); assert.deepStrictEqual({ ...s }, { f: 3, next: 3000 + 15 * MIN, stop: false });
  s = step(s, 4000); assert.deepStrictEqual({ ...s }, { f: 4, next: 0, stop: true }, "the 4th failure in a row stops the reward");
  const allows = vm.runInContext("(s, n) => claimBackoffAllows(s, n)", ctx);
  assert.ok(allows(null, 0) && !allows({ f: 1, next: 5000, stop: false }, 4999) && allows({ f: 1, next: 5000, stop: false }, 5000) && !allows({ f: 4, next: 0, stop: true }, 1e15));

  const html = read("popup.html"), js = read("popup.js");
  assert.ok(/id="claimWarning"/.test(html), "popup.html has the warning element");
  assert.ok(/claimHealth/.test(js) && /CLAIM_WARN_STREAK/.test(js) && /claim_fail_warning/.test(js), "popup.js shows it from claimHealth.streak");
  assert.ok(/changes\.claimHealth/.test(js), "and refreshes live when claimHealth changes");
  assert.ok(!/sessionStorage/.test(read("content.js").replace(/\/\/.*$/gm, "")), "content.js keeps no claim state of its own any more");
  console.log("  OK  schedule helpers (1 -> 5 -> 15 min, stop at 4), popup wiring, no per-tab state");
}

(async () => {
  console.log("Running claim backoff tests (fake tabs -> one real background, fake clock, no browser, no network)...\n");
  try {
    testScheduleHelpersAndPopupWiring();
    await testUnclaimableButtonFollowsTheSchedule();
    await testThreeTabsOnlyOneClicksPerRound();
    await testClosingAndReopeningTheInventoryKeepsTheCount();
    await testASuccessfulClaimIsRecordedAndForgotten();
    await testRewardsBackOffIndependently();
    await testATabThatDiesHoldsTheRewardOnlyBriefly();
    await testSwitchingOffReleasesTheReward();
    await testBackgroundStateOutlivesTheBackgroundPageAndDiesWithTheSession();
    await testBackgroundKeepsTheStreakAndLogsTheReason();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
