/**
 * claim-scan-scope.test.js
 *
 * content.js used to run its claim scan on EVERY twitch.tv page, and its
 * generic fallback clicked any button/[role=button] whose text or aria-label
 * *started with* a claim word - so the bare Thai "รับ" ("receive") also matched
 * "รับชม…" ("watch…") and "claim" matched "claimed…". Claim buttons only exist
 * on the inventory and on channel pages, so now:
 *   - the scan (observer, interval, initial and post-scroll passes all go
 *     through clickClaims) does nothing anywhere else - /drops/campaigns
 *     above all, which is one long list of accordion buttons;
 *   - "รับ" and the other short labels match the whole string only; a label
 *     that carries the reward name after the verb ("Claim Drop: <name>")
 *     still matches by prefix, but never the already-claimed forms.
 * Pages are checked at click time, not once at start-up, because Twitch is a
 * single-page app and navigates without reloading the content script.
 *
 * Runs the real content.js in a vm sandbox against a fake DOM (no browser).
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function fakeButton({ text = "", aria = null, reward = "a reward", notification = false, inCard = true, pointsArea = false }) {
  const btn = {
    textContent: text,
    disabled: false,
    clicks: 0,
    notification,
    getAttribute(name) { return name === "aria-label" ? aria : null; },
    closest(sel) { return pointsArea && /community-points/.test(sel) ? {} : null; },
    click() { this.clicks++; },
  };
  // a card (title link /drops/campaigns?dropID=...) holding this one button and its reward name;
  // inCard:false = a claim-labelled button that sits outside any campaign card
  if (inCard) {
    const p = { textContent: reward, querySelector: () => null };
    const link = { getAttribute: (n) => (n === "href" ? `/drops/campaigns?dropID=${reward.replace(/\W+/g, "-")}` : null) };
    const tier = { textContent: "100% of 1 hour", parentElement: null, querySelectorAll: (sel) => (/button/.test(sel) ? [btn] : sel === "p" ? [p] : []), querySelector: () => null };
    const card = {
      parentElement: null,
      querySelectorAll: (sel) => (/dropID/.test(sel) ? [link] : /button/.test(sel) ? [btn] : sel === "p" ? [p] : []),
      querySelector: (sel) => (/dropID/.test(sel) ? link : null),
    };
    tier.parentElement = card;
    btn.parentElement = tier;
  }
  return btn;
}

async function makeWorld({ pathname, buttons }) {
  const observers = [];
  const location = { pathname, href: `https://www.twitch.tv${pathname}` };
  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    Set, Map, Promise, URL,
    location,
    document: {
      body: {},
      // only the generic fallback selector returns anything; the specific
      // claim-button selectors match nothing in these fixtures
      // the generic scan sees every button; Twitch's drop-notification selector only the buttons flagged as one
      querySelectorAll: (sel) => (sel === 'button, [role="button"]' ? buttons
        : sel === 'button[data-a-target="drops-claim-button"]' ? buttons.filter((b) => b.notification) : []),
      querySelector: () => null,
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
      disconnect() {}
    },
    // timers never fire: every scan in this test is triggered by hand through the observer callback
    setInterval: () => 1, clearInterval: () => {},
    setTimeout: () => 1, clearTimeout: () => {},
    browser: {
      storage: {
        local: { get: () => Promise.resolve({ enabled: true }), set: () => Promise.resolve() },
        onChanged: { addListener: () => {} },
      },
      // background.js's claim gate always says yes here: this test is about WHICH buttons and pages, not about backoff
      runtime: { sendMessage: (m) => Promise.resolve(m && m.type === "claimAsk" ? { allowed: true } : undefined), onMessage: { addListener: () => {} } },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext(read("content.js"), ctx);
  await new Promise((r) => setImmediate(r)); // storage.local.get(...).then(start)
  assert.strictEqual(observers.length, 1, "content.js started and installed its observer");
  return { location, scan: () => observers[0].cb([]) };
}

const CLAIM = { text: "Claim Now" };

async function testNothingIsClickedOutsideInventoryAndChannelPages() {
  const pages = [
    ["/drops/campaigns", "the campaigns page"],
    ["/directory/category/rust", "a directory page"],
    ["/directory", "the browse page"],
    ["/", "the home page"],
    ["/settings/profile", "settings"],
    ["/videos/123456", "a VOD"],
  ];
  for (const [pathname, label] of pages) {
    // even a real, enabled "Claim Now" button and a Thai "รับ" button must be left alone
    const buttons = [fakeButton(CLAIM), fakeButton({ text: "รับ" }), fakeButton({ aria: "รับชมสตรีม" })];
    const w = await makeWorld({ pathname, buttons });
    await w.scan();
    assert.deepStrictEqual(buttons.map((b) => b.clicks), [0, 0, 0], `${label} (${pathname}) must never be scanned for claim buttons`);
  }
  console.log("  OK  no claim scan on /drops/campaigns, directory, home, settings or VOD pages");
}

async function testClaimsAreStillClickedOnInventoryAndChannelPages() {
  for (const pathname of ["/drops/inventory", "/drops/inventory/", "/ironmouse", "/Some_Channel"]) {
    const buttons = [fakeButton({ ...CLAIM, notification: !/inventory/.test(pathname) })]; // on a channel page: the drop notification's claim button
    const w = await makeWorld({ pathname, buttons });
    await w.scan();
    assert.strictEqual(buttons[0].clicks, 1, `${pathname}: a "Claim Now" button must still be auto-claimed`);
  }
  console.log("  OK  auto-claim still works on the inventory and on channel pages");
}

async function testSinglePageNavigationIsHonouredAtClickTime() {
  const buttons = [fakeButton({ ...CLAIM, notification: true })];
  const w = await makeWorld({ pathname: "/ironmouse", buttons }); // content script started on a channel page...
  w.location.pathname = "/drops/campaigns"; //                        ...then Twitch navigated in-page
  await w.scan();
  assert.strictEqual(buttons[0].clicks, 0, "after an in-page navigation to /drops/campaigns nothing is clicked");
  w.location.pathname = "/drops/inventory";
  await w.scan();
  assert.strictEqual(buttons[0].clicks, 1, "and scanning resumes when the user navigates to the inventory");

  const other = [fakeButton({ ...CLAIM, notification: true })];
  const w2 = await makeWorld({ pathname: "/drops/campaigns", buttons: other }); // started on campaigns, e.g. a fresh tab
  await w2.scan();
  assert.strictEqual(other[0].clicks, 0);
  w2.location.pathname = "/somechannel";
  await w2.scan();
  assert.strictEqual(other[0].clicks, 1, "a tab that started on /drops/campaigns claims once it is on a channel page");
  console.log("  OK  the page is checked at click time (single-page navigation both ways)");
}

async function testLabelMatchingIsWholeStringForShortLabels() {
  const cases = [
    // [button, expected to be clicked]
    [{ text: "รับ" }, true],
    [{ aria: "รับ" }, true],
    [{ text: "Claim" }, true],
    [{ text: "claim now" }, true],
    [{ aria: "Claim Drop: Rust Isles Boots" }, true],
    [{ aria: "claim your reward" }, true],
    [{ aria: "รับรางวัล Rust Isles Boots" }, true],
    [{ aria: "รับชมสตรีม" }, false],
    [{ aria: "รับชมพร้อมกัน" }, false],
    [{ aria: "รับข้อเสนอ Prime" }, false],
    [{ text: "รับชม" }, false],
    [{ aria: "Claimed" }, false],
    [{ aria: "claimed drops" }, false],
    [{ text: "Claimed" }, false],
    [{ aria: "รับรางวัลแล้ว" }, false],
  ];
  const buttons = cases.map(([spec], i) => fakeButton({ ...spec, reward: `reward ${i}` })); // one reward each
  const w = await makeWorld({ pathname: "/drops/inventory", buttons });
  await w.scan();
  cases.forEach(([spec, expected], i) => {
    assert.strictEqual(buttons[i].clicks > 0, expected,
      `${JSON.stringify(spec)} ${expected ? "is a claim button and must be clicked" : "is NOT a claim button and must not be clicked"}`);
  });
  console.log(`  OK  label matching: ${cases.length} labels (bare "รับ" exact, "รับชม…"/"claimed…" never)`);
}

(async () => {
  console.log("Running claim-scan scope tests (no real browser, no network)...\n");
  try {
    await testNothingIsClickedOutsideInventoryAndChannelPages();
    await testClaimsAreStillClickedOnInventoryAndChannelPages();
    await testSinglePageNavigationIsHonouredAtClickTime();
    await testLabelMatchingIsWholeStringForShortLabels();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
