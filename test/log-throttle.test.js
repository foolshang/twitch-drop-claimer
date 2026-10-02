/**
 * log-throttle.test.js
 *
 * A bug report of 0.6.17 was 1000 lines of the same few messages: "[verify] ... waiting" every
 * tick and the pinned live/flash line, which pushed everything else - including the window
 * lines that explain where a tab was opened - out of the 1000-line ring. Now:
 *
 * - a line that repeats every tick is logged only when its state CHANGES, plus one short
 *   summary every 15 minutes while it stays the same (logOnChange);
 * - the window / session lifecycle lines are also kept in a small buffer of their own that
 *   ordinary lines never push out (the "survive 1000+ lines in a report" case is in
 *   bug-report-chunking.test.js).
 *
 * The real background.js in a vm sandbox with a fake clock.
 */

const vm = require("vm");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { MIN, flush, makeClock, makeBackground } = require("./claim-harness");

const lines = (bg, re) => bg.logLines().filter((l) => re.test(l));

async function testSameStateIsLoggedOnceThenSummarisedEvery15Minutes() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  const call = (state, ...a) => vm.runInContext(`logOnChange("verify:rust", ${JSON.stringify(state)}, ...${JSON.stringify(a)})`, bg.ctx);

  // 200 ticks of one minute each with the same state
  for (let i = 0; i < 200; i++) { call("healthy", "[verify] rust waiting", i, "s"); clock.advanceTo(clock.now + MIN); }
  const verify = lines(bg, /\[verify\] rust waiting|\[summary\] verify:rust/);
  const plain = lines(bg, /\[bg\] \[verify\] rust waiting/);
  const summaries = lines(bg, /\[summary\] verify:rust/);
  assert.strictEqual(plain.length, 1, "the line itself is logged once: " + plain.length);
  assert.strictEqual(summaries.length, Math.floor(199 / 15), "one summary per 15 minutes (200 ticks = 199 minutes): " + summaries.length);
  assert.ok(verify.length < 20, "200 repeated lines became " + verify.length);
  assert.ok(/still "healthy" for 15 min/.test(summaries[0]) && /15 identical lines not logged/.test(summaries[0]), summaries[0]);
  console.log(`  OK  200 identical ticks -> ${verify.length} lines (1 + ${summaries.length} summaries)`);

  // a change of state is logged at once, then the new state is throttled again
  call("no-reading", "[verify] rust no reading");
  call("no-reading", "[verify] rust no reading");
  call("healthy", "[verify] rust healthy again");
  assert.strictEqual(lines(bg, /rust no reading/).length, 1, "the new state once");
  assert.strictEqual(lines(bg, /rust healthy again/).length, 1, "and back again");

  // independent keys do not throttle each other
  call("healthy", "[verify] rust again");
  vm.runInContext(`logOnChange("verify:poe", "healthy", "[verify] poe waiting")`, bg.ctx);
  assert.strictEqual(lines(bg, /\[verify\] poe waiting/).length, 1);
  console.log("  OK  a state change is logged at once; each channel/slug has its own state");
}

async function testCallSitesUseIt() {
  const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  // the per-tick lines must go through logOnChange, never plain log()
  const plainVerify = [...src.matchAll(/\blog\(\s*"\[verify\]", (?:slug|v\.slug)[^;]*;/g)].map((m) => m[0]);
  assert.strictEqual(plainVerify.length, 1, "only the stalled verdict (an event, not a per-tick line) is logged every time: " + plainVerify.length);
  assert.ok(/flagged stalled/.test(plainVerify[0]));
  assert.ok(!/\blog\("pinned channel", channel, "(is live|went live)/.test(src), "the pinned live/flash lines are throttled");
  assert.ok(/logOnChange\(`pinned-live:\$\{channel\}`, "flashed"/.test(src));
  console.log("  OK  [verify] and pinned live/flash lines go through logOnChange");
}

async function testWindowLinesGoToTheLifecycleBuffer() {
  const clock = makeClock();
  const bg = await makeBackground({ clock });
  vm.runInContext(`
    browser.windows.create = () => Promise.resolve({ id: 9, tabs: [{ id: 5 }] });
    browser.sessions = { setWindowValue: () => Promise.resolve(), getWindowValue: () => Promise.resolve(undefined) };
  `, bg.ctx);
  const res = await vm.runInContext("getOrCreateWatchWindow()", bg.ctx);
  await flush();
  assert.strictEqual(res.id, 9);
  const life = vm.runInContext("lifecycleLogBuffer.slice()", bg.ctx);
  assert.ok(life.some((l) => /created the watch window 9 \(tagged\)/.test(l)), "creation is a lifecycle line: " + JSON.stringify(life));

  // a failed creation is one too
  vm.runInContext(`browser.windows.create = () => Promise.reject(new Error("boom")); watchWindowId = null;`, bg.ctx);
  await vm.runInContext(`browser.storage.local.set({ watchWindowId: null }).then(() => getOrCreateWatchWindow())`, bg.ctx);
  const life2 = vm.runInContext("lifecycleLogBuffer.slice()", bg.ctx);
  assert.ok(life2.some((l) => /could not create the watch window/.test(l)), "failure is a lifecycle line");
  console.log("  OK  window created / could not create -> lifecycle lines");
}

(async () => {
  console.log("Running log throttle / lifecycle log tests...\n");
  try {
    await testSameStateIsLoggedOnceThenSummarisedEvery15Minutes();
    await testCallSitesUseIt();
    await testWindowLinesGoToTheLifecycleBuffer();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
