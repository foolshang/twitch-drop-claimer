/**
 * integrity-signals.test.js
 *
 * Seen live (2026-09-30, confirmed by the user in their real Firefox): Twitch
 * flagged a session/device and refused Drops-only GraphQL operations with
 * `errors: [{message: "failed integrity check"}]` - ViewerDropsDashboard (the
 * campaign list), DropsInventoryRewardGroupStatus (the drops in a campaign),
 * DropsPage_ClaimDropRewards (the claim) - while every other operation, the
 * inventory's own `Inventory` included, kept working. Clearing twitch.tv cookies
 * and logging in again fixed it. So:
 *   inject.js       reports `integrityFailed` for those operations (and
 *                   `dropsOpOk` when an operation that fails in a flagged
 *                   session works, which proves the flag is gone);
 *   background.js   on `integrityFailed` stops auto-claim in EVERY tab at once
 *                   (no waiting for the per-reward backoff), logs it once and
 *                   sets storage.session `integrityFlag` for the popup; clears
 *                   on `dropsOpOk` and on a new browser session;
 *   a claim refused because the GAME ACCOUNT IS NOT CONNECTED is a different
 *   thing: only that reward stops for the session, everything else keeps
 *   claiming, and it never counts toward the integrity/streak warnings; the
 *   popup says to connect the account on the campaigns page.
 *
 * Real inject.js / content.js / background.js in vm sandboxes with fake GQL
 * responses, a fake DOM and a fake clock - no browser, no network, no session.
 */

const vm = require("vm");
const assert = require("assert");
const {
  SEC, MIN, flush, read, makeClock, makeBackground, claimButton, removeButton, openTab, run, K,
} = require("./claim-harness");

// ---- inject.js against fake GQL responses ------------------------------------
function injectWorld() {
  const posted = [];
  const state = { responseText: "[]" };
  const nativeFetch = () => Promise.resolve({ clone: () => ({ text: () => Promise.resolve(state.responseText) }) });
  const win = {
    fetch: nativeFetch,
    postMessage: (m) => posted.push(m),
    location: { href: "https://www.twitch.tv/drops/inventory", origin: "https://www.twitch.tv" },
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date, JSON, Math, Set, Map, Promise, RegExp, Object, Array, String, Number,
    window: win,
    XMLHttpRequest: function XMLHttpRequest() {},
  };
  sandbox.XMLHttpRequest.prototype = { open() {}, send() {}, addEventListener() {} };
  vm.runInContext(read("inject.js"), vm.createContext(sandbox));
  return {
    posted,
    signals: () => JSON.parse(JSON.stringify(posted.map((m) => m.payload.signal))), // plain objects (they come from the vm realm)
    // the page makes one batched request with these operations and Twitch answers with `bodies`
    async exchange(ops, bodies) {
      state.responseText = JSON.stringify(bodies);
      await win.fetch("https://gql.twitch.tv/gql", { method: "POST", body: JSON.stringify(ops.map((operationName) => ({ operationName }))) });
      await flush();
    },
  };
}

const INTEGRITY = { errors: [{ message: "failed integrity check" }], data: null };
const OPS = ["ViewerDropsDashboard", "Inventory", "DropsInventoryRewardGroupStatus", "DropsPage_ClaimDropRewards"];

// what a working response of each operation looks like
const OK_BODY = {
  ViewerDropsDashboard: { data: { currentUser: { id: "1", dropCampaigns: [{ id: "c", status: "ACTIVE", endAt: "2999-01-01T00:00:00Z", game: { id: "9", displayName: "Rust" }, self: { isAccountConnected: true } }] } } },
  Inventory: { data: { currentUser: { id: "1", inventory: { dropCampaignsInProgress: [{ status: "ACTIVE", game: { id: "9", name: "Rust" } }] } } } },
  DropsInventoryRewardGroupStatus: { data: { dropsCampaign: { id: "c", rewardGroupStatuses: [] } } },
  DropsPage_ClaimDropRewards: { data: { claimDropRewards: { status: "ELIGIBLE_FOR_ALL", isUserAccountConnected: true } } },
};

async function testIntegrityErrorsAreReportedForTheFourOperations() {
  for (const op of OPS) {
    const w = injectWorld();
    await w.exchange([op], [INTEGRITY]);
    const failed = w.signals().filter((s) => s.kind === "integrityFailed");
    assert.strictEqual(failed.length, 1, `${op}: one integrityFailed signal`);
    assert.strictEqual(failed[0].operationName, op);
    assert.ok(!w.signals().some((s) => s.kind === "dropsOpOk" || s.kind === "claimNotLinked"), `${op}: nothing else`);
  }
  // wording is matched loosely; other errors are not integrity failures
  const w = injectWorld();
  await w.exchange(["ViewerDropsDashboard"], [{ errors: [{ message: "Failed Integrity Check (token expired)" }], data: null }]);
  assert.strictEqual(w.signals().filter((s) => s.kind === "integrityFailed").length, 1);
  const other = injectWorld();
  await other.exchange(["ViewerDropsDashboard", "DropsPage_ClaimDropRewards"], [
    { errors: [{ message: "service timeout" }], data: null },
    { errors: [{ message: "internal error" }], data: null },
  ]);
  assert.deepStrictEqual(other.signals(), [{ kind: "claimRequest", operationName: "DropsPage_ClaimDropRewards", seq: 0 }], "no integrity signal for other errors (only the claim request marker)");
  // an operation nobody asked about is left alone
  const unrelated = injectWorld();
  await unrelated.exchange(["DailyViewDropCollection"], [INTEGRITY]);
  assert.deepStrictEqual(unrelated.signals(), []);
  // a mixed batch: only the refused operations are reported
  const mixed = injectWorld();
  await mixed.exchange(["SideNav", "ViewerDropsDashboard", "Inventory"], [{ data: { currentUser: null } }, INTEGRITY, OK_BODY.Inventory]);
  assert.deepStrictEqual(mixed.signals().filter((s) => s.kind === "integrityFailed").map((s) => s.operationName), ["ViewerDropsDashboard"]);
  console.log("  OK  inject.js: integrityFailed for the 4 operations, not for other errors/operations");
}

async function testNormalResponsesChangeNothing() {
  for (const op of OPS) {
    const w = injectWorld();
    await w.exchange([op], [OK_BODY[op]]);
    assert.ok(!w.signals().some((s) => s.kind === "integrityFailed"), `${op}: a normal response is no integrity failure`);
    const ok = w.signals().filter((s) => s.kind === "dropsOpOk");
    // Inventory works even in a flagged session (seen live): it proves nothing
    assert.strictEqual(ok.length, op === "Inventory" ? 0 : 1, `${op}: dropsOpOk only for operations that fail in a flagged session`);
  }
  // null data without errors, or errors of any kind: not "ok"
  const w = injectWorld();
  await w.exchange(["ViewerDropsDashboard", "DropsInventoryRewardGroupStatus"], [{ data: { currentUser: null } }, { data: { dropsCampaign: null } }]);
  assert.ok(!w.signals().some((s) => s.kind === "dropsOpOk"), "empty data is not proof of anything");
  // the existing extractors still work next to the new checks
  const dash = injectWorld();
  await dash.exchange(["ViewerDropsDashboard"], [OK_BODY.ViewerDropsDashboard]);
  assert.ok(dash.signals().some((s) => s.kind === "openCampaigns"), "openCampaigns still extracted");
  const inv = injectWorld();
  await inv.exchange(["Inventory"], [OK_BODY.Inventory]);
  assert.ok(inv.signals().some((s) => s.kind === "gameIds"), "gameIds still extracted");
  console.log("  OK  inject.js: normal responses report no failure (dropsOpOk only where it is proof); old extractors intact");
}

async function testAccountNotLinkedIsNotAnIntegrityFailure() {
  const cases = [
    ["message", { errors: [{ message: "Connect your Twitch and game accounts to claim this reward" }], data: null }],
    ["error code", { errors: [{ message: "nope", extensions: { code: "ACCOUNT_NOT_LINKED" } }], data: null }],
    ["payload flag", { data: { claimDropRewards: { status: "ELIGIBLE_FOR_ALL", isUserAccountConnected: false } } }],
  ];
  for (const [label, body] of cases) {
    const w = injectWorld();
    await w.exchange(["DropsPage_ClaimDropRewards"], [body]);
    const kinds = w.signals().map((s) => s.kind);
    assert.deepStrictEqual(kinds, ["claimRequest", "claimNotLinked"], `${label}: reported as not linked, and only that`);
    assert.strictEqual(w.signals()[1].seq, 0);
  }
  const integrity = injectWorld();
  await integrity.exchange(["DropsPage_ClaimDropRewards"], [INTEGRITY]);
  assert.ok(!integrity.signals().some((s) => s.kind === "claimNotLinked"), "an integrity refusal is not an account-link problem");
  console.log("  OK  inject.js: an unconnected game account is its own signal, never an integrity failure");
}

async function testClaimRequestsAreNumberedInRequestOrder() {
  const w = injectWorld();
  await w.exchange(["DropsPage_ClaimDropRewards", "SideNav", "DropsPage_ClaimDropRewards"], [OK_BODY.DropsPage_ClaimDropRewards, { data: {} }, OK_BODY.DropsPage_ClaimDropRewards]);
  await w.exchange(["DropsPage_ClaimDropRewards"], [OK_BODY.DropsPage_ClaimDropRewards]);
  const markers = w.signals().filter((s) => s.kind === "claimRequest").map((s) => s.seq);
  assert.deepStrictEqual(markers, [0, 1, 2], "each claim request gets the next number as it goes out");
  console.log("  OK  inject.js: claim requests are numbered in request order");
}

// ---- background.js: the integrity flag ------------------------------------------
const gqlSignal = (operationName, kind, extra = {}) => ({ type: "gqlDropSignal", operationName, signal: { kind, operationName, ...extra }, at: 0 });
const integrityFailed = (op = "ViewerDropsDashboard") => gqlSignal(op, "integrityFailed");
const dropsOpOk = (op = "ViewerDropsDashboard") => gqlSignal(op, "dropsOpOk");

async function testIntegrityFailureStopsClaimingEverywhereAtOnce() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const clickLog = [];
  const tabs = [];
  for (const id of [1, 2, 3]) {
    const tab = await openTab({ clock, bg, id, clickLog });
    claimButton(tab, "Rust Isles Boots");
    tabs.push(tab);
  }
  // Twitch refuses the campaign list; nothing has been claimed or failed yet (no backoff has started)
  await bg.send(integrityFailed(), 9);
  assert.strictEqual(bg.entry(K("Rust Isles Boots")), undefined, "no per-reward state involved");
  await run(tabs, 90 * SEC);
  assert.strictEqual(clickLog.length, 0, "three tabs, 90 s: not one click");
  assert.strictEqual((await bg.send({ type: "claimAsk", key: "anything else" })).reason, "integrity", "any reward is refused, not just the ones seen");

  assert.ok(bg.session.integrityFlag && bg.session.integrityFlag.op === "ViewerDropsDashboard", "flag in storage.session for the popup");
  const lines = bg.logLines().filter((l) => /failed integrity check/.test(l));
  assert.strictEqual(lines.length, 1, "one clear log line: " + lines.join(" | "));
  assert.ok(/flagged/.test(lines[0]) && /clear twitch\.tv cookies and log in again/.test(lines[0]) && /stopped in every tab/.test(lines[0]));

  // it fires again on every page load, several times: no log/storage spam, flag unchanged
  const since = bg.session.integrityFlag.since;
  for (let i = 0; i < 5; i++) await bg.send(integrityFailed("DropsInventoryRewardGroupStatus"), 2);
  assert.strictEqual(bg.logLines().filter((l) => /failed integrity check/.test(l)).length, 1);
  assert.strictEqual(bg.session.integrityFlag.since, since);
  assert.ok(!bg.local.claimHealth, "an integrity refusal is not a claim failure: the streak is untouched");
  console.log("  OK  integrityFailed: no claim in any tab at once, one log line, flag in storage.session, streak untouched");
}

async function testNormalResponseChangesNothingInBackground() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const tab = await openTab({ clock, bg, id: 1 });
  const btn = claimButton(tab, "Boots");
  const linesBefore = bg.logLines().length;
  await bg.send(dropsOpOk(), 1); // Twitch answering normally while nothing is flagged
  await bg.send(dropsOpOk("DropsPage_ClaimDropRewards"), 1);
  assert.ok(!bg.session.integrityFlag, "no flag");
  assert.strictEqual(bg.logLines().length, linesBefore, "nothing logged");
  await tab.scan();
  await flush();
  assert.strictEqual(btn.clicks, 1, "claiming carries on as usual");
  console.log("  OK  a normal response changes nothing (no flag, no log, claiming continues)");
}

async function testFlagClearsWhenADropsOperationWorksAgain() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  // a reward given up on before (4 rejected claims) and a popup warning from it
  for (let i = 0; i < 4; i++) {
    assert.strictEqual((await bg.send({ type: "claimAsk", key: "Boots" })).allowed, true);
    await bg.send({ type: "claimResult", key: "Boots", ok: false });
    clock.advanceTo(clock.now + 20 * MIN);
  }
  assert.strictEqual(bg.entry("Boots").stop, true);
  await bg.send(integrityFailed());
  assert.strictEqual((await bg.send({ type: "claimAsk", key: "Boots" })).allowed, false);

  await bg.send(gqlSignal("Inventory", "gameIds", { games: [{ id: "1", name: "Rust" }] }), 1); // Inventory answering says nothing about integrity
  assert.ok(bg.session.integrityFlag, "still flagged: only an operation that fails when flagged can clear it");

  await bg.send(dropsOpOk("DropsInventoryRewardGroupStatus"), 1);
  assert.strictEqual(bg.session.integrityFlag, null, "cleared");
  assert.strictEqual((await bg.send({ type: "claimAsk", key: "Boots" })).allowed, true, "claiming resumes, the old refusals do not hold it back");
  assert.strictEqual(bg.local.claimHealth, null, "and the streak warning goes with it");
  assert.ok(bg.logLines().some((l) => /Drops operations work again/.test(l) && /auto-claim resumes/.test(l)));
  console.log("  OK  the flag clears when a Drops operation works again (Inventory does not count) and old refusals are forgotten");
}

async function testANewBrowserSessionClearsTheFlag() {
  const clock = makeClock();
  const stale = { integrityFlag: { since: 1, op: "ViewerDropsDashboard" } }; // left over, no session marker: Firefox restarted
  const bg = await makeBackground({ clock, session: stale });
  assert.strictEqual((await bg.send({ type: "claimAsk", key: "Boots" })).allowed, true, "a new browser session starts unflagged");
  assert.strictEqual(stale.integrityFlag, null, "and the mirror is cleared");

  // within one browser session a reloaded background page reads the flag back
  const session = { tdcSessionStarted: 1 };
  const bg1 = await makeBackground({ clock, session });
  await bg1.send(integrityFailed(), 1);
  const bg2 = await makeBackground({ clock, session });
  assert.strictEqual((await bg2.send({ type: "claimAsk", key: "Boots" })).reason, "integrity", "still flagged after a background reload");
  console.log("  OK  a new browser session clears the flag; a background reload inside a session keeps it");
}

async function testTabsResumeAfterTheFlagClears() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const clickLog = [];
  const tab = await openTab({ clock, bg, id: 1, clickLog });
  claimButton(tab, "Boots");
  await bg.send(integrityFailed(), 1);
  await run([tab], 60 * SEC);
  assert.strictEqual(clickLog.length, 0);
  await bg.send(dropsOpOk("ViewerDropsDashboard"), 1);
  await run([tab], 10 * SEC);
  assert.strictEqual(clickLog.length, 1, "the very next scan claims again");
  console.log("  OK  claiming resumes in the tab as soon as the flag clears");
}

// ---- account not connected --------------------------------------------------------
async function testAccountNotLinkedStopsOnlyThatReward() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const clickLog = [];
  const tab = await openTab({ clock, bg, id: 1, clickLog, gameIdMap: { 123: "Rust" } });
  const boots = claimButton(tab, "Rust Isles Boots", { gameId: "123" });
  const fine = claimButton(tab, "Fine reward", { onClick: (b) => removeButton(tab, b) });
  // a claim request the user made by hand goes out while none of our clicks is waiting for its request: no pairing
  tab.postSignal("DropsPage_ClaimDropRewards", { kind: "claimRequest", seq: 5 });
  await tab.scan();
  await flush();
  assert.strictEqual(boots.clicks + fine.clicks, 2, "both rewards clicked in the first scan");

  tab.postSignal("DropsPage_ClaimDropRewards", { kind: "claimRequest", seq: 6 }); // ours: Rust Isles Boots
  tab.postSignal("DropsPage_ClaimDropRewards", { kind: "claimRequest", seq: 7 }); // ours: Fine reward
  // Twitch: "connect your game account" for the request numbered 6
  tab.postSignal("DropsPage_ClaimDropRewards", { kind: "claimNotLinked", seq: 6 });
  await flush();
  await flush();

  assert.deepStrictEqual({ ...bg.entry(K("Rust Isles Boots")) }, { f: 0, next: 0, stop: true, notLinked: true }, "that reward stops for the session");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bg.local.claimNotLinked)), [{ key: K("Rust Isles Boots"), game: "Rust" }], "with its game, for the popup");
  assert.ok(bg.logLines().some((l) => /claim needs a linked game account/.test(l) && /Rust Isles Boots/.test(l) && /campaigns page/.test(l)));
  assert.strictEqual((bg.local.claimHealth || {}).streak || 0, 0, "right away: not a claim failure, the streak is untouched");
  assert.ok(!bg.session.integrityFlag, "and not an integrity failure");

  await run([tab], 30 * SEC); // verdicts arrive
  assert.deepStrictEqual(tab.results().map((m) => [m.key, m.ok]), [[K("Fine reward"), true]], "the refused reward is not reported as a failed attempt; the other one was claimed");
  assert.strictEqual((bg.local.claimHealth || {}).streak || 0, 0, "it does not count toward the claim-failure warning");
  assert.ok(!bg.session.integrityFlag, "nor toward the integrity warning");

  // the refused reward is left alone from now on, everything else keeps claiming
  const other = claimButton(tab, "Other reward", { onClick: (b) => removeButton(tab, b) });
  await run([tab], 20 * SEC);
  assert.strictEqual(boots.clicks, 1, "never clicked again");
  assert.strictEqual(other.clicks, 1, "another reward is claimed at once");
  assert.strictEqual((await bg.send({ type: "claimAsk", key: K("Rust Isles Boots") }, 4)).reason, "stopped", "in every tab");

  // a signal for a number that pairs with no click of ours is ignored
  tab.postSignal("DropsPage_ClaimDropRewards", { kind: "claimNotLinked", seq: 5 });
  await flush();
  assert.strictEqual(bg.local.claimNotLinked.length, 1);
  console.log("  OK  account-link error: only that reward stops (with its game), others keep claiming, no warning counters touched");
}

async function testConnectingTheAccountResumesTheReward() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const tab = await openTab({ clock, bg, id: 1, gameIdMap: { 123: "Rust" } });
  const boots = claimButton(tab, "Rust Isles Boots", { gameId: "123" });
  await tab.scan();
  await flush();
  tab.postSignal("DropsPage_ClaimDropRewards", { kind: "claimRequest", seq: 0 });
  tab.postSignal("DropsPage_ClaimDropRewards", { kind: "claimNotLinked", seq: 0 });
  await flush();
  await flush();
  assert.strictEqual((await bg.send({ type: "claimAsk", key: K("Rust Isles Boots") })).allowed, false);

  // the user connects the account; the campaigns page's own data says so
  await bg.send(gqlSignal("ViewerDropsDashboard", "openCampaigns", { snapshot: true, games: [{ id: "123", name: "Rust", active: true, endAt: null, accountConnected: true }] }), 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bg.local.claimNotLinked)), [], "warning gone");
  assert.strictEqual((await bg.send({ type: "claimAsk", key: K("Rust Isles Boots") })).allowed, true, "and the reward may be claimed again");
  assert.ok(boots.clicks === 1);
  console.log("  OK  once the campaigns data says the account is connected the reward is claimed again");
}

// ---- popup wiring ---------------------------------------------------------------------
function testPopupWiring() {
  const html = read("popup.html"), js = read("popup.js");
  assert.ok(/id="integrityWarning"/.test(html) && /id="notLinkedWarnings"/.test(html));
  assert.ok(/storage\.session\.get\("integrityFlag"\)/.test(js) && /integrity_warning/.test(js), "popup shows the integrity warning from storage.session");
  assert.ok(/area === "session"/.test(js) && /changes\.integrityFlag/.test(js), "and follows it live");
  assert.ok(/claimNotLinked/.test(js) && /claim_not_linked_warning/.test(js) && /claim_open_campaigns/.test(js), "one warning per game/reward");
  assert.ok(/https:\/\/www\.twitch\.tv\/drops\/campaigns/.test(js), "with a link to the campaigns page");
  assert.ok(/\$claimWarning\.hidden = !!integrityFlag/.test(js), "the vaguer streak warning steps aside while the integrity one shows");
  const { I18N, I18N_LANGS } = require("../i18n.js");
  for (const { code } of I18N_LANGS) {
    for (const k of ["integrity_warning", "claim_not_linked_warning", "claim_open_campaigns"]) assert.ok(I18N[code][k], `${code}.${k}`);
    assert.ok(/\{game\}/.test(I18N[code].claim_not_linked_warning), `${code}: {game} placeholder`);
  }
  console.log("  OK  popup: integrity + account-link warnings wired, all 9 languages");
}

(async () => {
  console.log("Running integrity / account-link tests (fake GQL, fake tabs, fake clock; no browser, no network)...\n");
  try {
    await testIntegrityErrorsAreReportedForTheFourOperations();
    await testNormalResponsesChangeNothing();
    await testAccountNotLinkedIsNotAnIntegrityFailure();
    await testClaimRequestsAreNumberedInRequestOrder();
    await testIntegrityFailureStopsClaimingEverywhereAtOnce();
    await testNormalResponseChangesNothingInBackground();
    await testFlagClearsWhenADropsOperationWorksAgain();
    await testANewBrowserSessionClearsTheFlag();
    await testTabsResumeAfterTheFlagClears();
    await testAccountNotLinkedStopsOnlyThatReward();
    await testConnectingTheAccountResumesTheReward();
    testPopupWiring();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
