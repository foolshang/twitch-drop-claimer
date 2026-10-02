/**
 * bug-report-chunking.test.js
 *
 * The "send bug report" button used to POST the whole debug-log buffer as one
 * request. The relay rejects any body over 60,000 bytes with a 413 it sends
 * before reading the body, so a full 1000-line buffer surfaced as an opaque
 * fetch "NetworkError" instead of an issue. reportBugToGitHub() now cuts the
 * log into parts whose `log` stays under REPORT_CHUNK_MAX_BYTES and sends each
 * as its own request. These tests drive the real background.js against a
 * stubbed fetch/browser (no network) and check what would go on the wire.
 */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const RELAY_MAX_BODY_BYTES = 60_000; // report-service/main.py MAX_BODY_BYTES
const WIRE_LIMIT = 50_000; // what the user asked for, whole request body

function makeSandbox({ failOnCall } = {}) {
  const storageData = { enabled: false, uiLang: "th" };
  const posts = [];
  let issueNo = 100;

  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, URL: globalThis.URL, Blob: globalThis.Blob,
    fetch: async (url, opts) => {
      posts.push({ url, opts, body: JSON.parse(opts.body), bytes: Buffer.byteLength(opts.body, "utf8") });
      if (failOnCall && posts.length === failOnCall) {
        return { ok: false, status: 429, json: async () => ({ ok: false, error: "rate limited, try again later" }) };
      }
      const n = ++issueNo;
      return { ok: true, status: 200, json: async () => ({ ok: true, issue: n, url: `https://gh/issues/${n}` }) };
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
        onChanged: { addListener: () => {} },
      },
      runtime: { onMessage: { addListener: () => {} }, getManifest: () => ({ version: "0.0.0-test" }) },
      tabs: { query: () => Promise.resolve([]), get: () => Promise.reject(new Error("none")), reload: () => {} },
      alarms: { create: () => {}, clear: () => Promise.resolve(true), onAlarm: { addListener: () => {} } },
      browserAction: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, setTitle: () => {} },
      downloads: { download: () => Promise.resolve(1), search: () => Promise.resolve([]) },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("shared.js"), ctx);
  vm.runInContext(read("i18n.js"), ctx);
  vm.runInContext(read("background.js"), ctx);
  return { ctx, posts };
}

const fillBuffer = (ctx, lines) => {
  const buf = vm.runInContext("debugLogBuffer", ctx);
  buf.length = 0;
  buf.push(...lines);
};

// what a report carries ahead of the ordinary ring: the lifecycle section (empty here) and the ring's header
const REPORT_HEAD = "=== window / session lifecycle (kept separately, never pushed out) ===\n(none yet)\n=== log ===\n";

const realisticLines = (n, extra = "") =>
  Array.from({ length: n }, (_, i) =>
    `[2026-09-28T14:${String(i % 60).padStart(2, "0")}:00.000Z] [bg] "verify" slug=path-of-exile-2 ch=streamer${i} ` +
    `progress={"a":${i},"b":"quote\\"d"} เปลี่ยนช่องเพราะไม่มีความคืบหน้า ${extra}`);

async function testSmallLogIsOneRequestUnchanged() {
  const { ctx, posts } = makeSandbox();
  fillBuffer(ctx, ["line one", "line two"]);
  const res = await vm.runInContext("reportBugToGitHub", ctx)();

  assert.strictEqual(res.ok, true);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].body.log, REPORT_HEAD + "line one\nline two", "single part carries no part header");
  assert.strictEqual(res.parts, 1);
  assert.strictEqual(res.url, "https://gh/issues/101");
  console.log("  OK  a small log is still exactly one plain request");
}

async function testFullBufferSplitsIntoBoundedPartsLosslessly() {
  const { ctx, posts } = makeSandbox();
  const lines = realisticLines(1000);
  fillBuffer(ctx, lines);
  const raw = Buffer.byteLength(lines.join("\n"), "utf8");
  assert.ok(raw > RELAY_MAX_BODY_BYTES, `fixture must reproduce the bug (raw ${raw} B > relay cap)`);

  const res = await vm.runInContext("reportBugToGitHub", ctx)();
  assert.strictEqual(res.ok, true);
  assert.ok(posts.length >= 2, "must split");
  assert.strictEqual(res.parts, posts.length);
  assert.strictEqual(res.urls.length, posts.length);

  const stripped = [];
  posts.forEach((p, i) => {
    assert.ok(p.bytes <= WIRE_LIMIT, `part ${i + 1} body is ${p.bytes} B, over ${WIRE_LIMIT}`);
    assert.ok(p.bytes < RELAY_MAX_BODY_BYTES);
    const m = p.body.log.match(new RegExp(`^=== bug report (\\S+) - part ${i + 1}/${posts.length} ===\\n`));
    assert.ok(m, `part ${i + 1} must be labelled part ${i + 1}/${posts.length}`);
    stripped.push(p.body.log.slice(m[0].length));
    assert.strictEqual(p.body.version, "0.0.0-test");
    assert.strictEqual(p.body.lang, "th");
  });
  const ids = new Set(posts.map((p) => p.body.log.split(" ")[3]));
  assert.strictEqual(ids.size, 1, "all parts share one report id");
  assert.strictEqual(stripped.join("\n"), REPORT_HEAD + lines.join("\n"), "no line lost, duplicated, or reordered");

  console.log(`  OK  1000 lines (${raw} B) -> ${posts.length} parts, max body ${Math.max(...posts.map((p) => p.bytes))} B, lossless`);
}

// The window lifecycle lines live in a buffer of their own: 1000+ ordinary lines push them out of the
// ordinary ring, but every report (and the exported file) still starts with them.
async function testLifecycleLinesSurviveAFloodOfOrdinaryLines() {
  const { ctx, posts } = makeSandbox();
  vm.runInContext(`logLifecycle("created the watch window", 7, "(tagged)"); logLifecycle("master switch", "ON");`, ctx);
  vm.runInContext(`for (let i = 0; i < 1500; i++) log("ordinary line", i);`, ctx);
  const ring = vm.runInContext("debugLogBuffer", ctx);
  assert.strictEqual(ring.length, 1000, "the ordinary ring is full");
  assert.ok(!ring.some((l) => /created the watch window/.test(l)), "the ordinary ring has lost the window line (this is the bug)");

  const res = await vm.runInContext("reportBugToGitHub", ctx)();
  assert.strictEqual(res.ok, true);
  const text = posts.map((p) => p.body.log).join("\n");
  assert.ok(/created the watch window 7 \(tagged\)/.test(text), "the report still carries the window line");
  assert.ok(/master switch ON/.test(text), "and the switch line");
  assert.ok(text.indexOf("created the watch window") < text.indexOf("=== log ==="), "in its own section, ahead of the ordinary lines");

  const exported = vm.runInContext("allLogLines()", ctx).join("\n"); // what exportDebugLogToFile writes
  assert.ok(/created the watch window 7/.test(exported));
  console.log("  OK  window lifecycle lines survive 1500 ordinary lines and are in every report / export");
}

async function testLifecycleBufferIsBoundedButIndependent() {
  const { ctx } = makeSandbox();
  vm.runInContext(`for (let i = 0; i < 500; i++) logLifecycle("lifecycle", i);`, ctx);
  const n = vm.runInContext("lifecycleLogBuffer.length", ctx);
  assert.strictEqual(n, 200, "small and bounded");
  console.log("  OK  the lifecycle buffer is small (200) and bounded");
}

async function testEscapeHeavyLogStillFitsOnTheWire() {
  const { ctx, posts } = makeSandbox();
  // quotes/backslashes/tabs all grow when JSON-escaped: raw size understates the wire size
  const lines = Array.from({ length: 800 }, (_, i) => `"q${i}"\t\\path\\to\\"x"`.repeat(6));
  fillBuffer(ctx, lines);
  const res = await vm.runInContext("reportBugToGitHub", ctx)();
  assert.strictEqual(res.ok, true);
  for (const p of posts) assert.ok(p.bytes <= WIRE_LIMIT, `escape-heavy body ${p.bytes} B over ${WIRE_LIMIT}`);
  console.log(`  OK  escape-heavy log measured by JSON-escaped size (max ${Math.max(...posts.map((p) => p.bytes))} B)`);
}

async function testSingleGiantLineIsSlicedNotDropped() {
  const { ctx, posts } = makeSandbox();
  const giant = "é😀\u0001x".repeat(30_000); // multi-byte, astral, control-char escapes
  fillBuffer(ctx, ["before", giant, "after"]);
  const res = await vm.runInContext("reportBugToGitHub", ctx)();
  assert.strictEqual(res.ok, true);
  for (const p of posts) assert.ok(p.bytes <= WIRE_LIMIT, `giant-line body ${p.bytes} B over ${WIRE_LIMIT}`);
  const joined = posts.map((p) => p.body.log.replace(/^=== bug report .* ===\n/, "")).join("\n").replace(REPORT_HEAD, "");
  assert.ok(joined.includes("before") && joined.includes("after"));
  assert.strictEqual(joined.replace(/[\n]|before|after/g, ""), giant, "giant line content fully preserved (surrogates intact)");
  console.log(`  OK  one ${giant.length}-char line is sliced across ${posts.length} parts without corruption`);
}

async function testStopsAtFirstFailureAndSaysWhere() {
  const { ctx, posts } = makeSandbox({ failOnCall: 2 });
  fillBuffer(ctx, realisticLines(1000));
  const res = await vm.runInContext("reportBugToGitHub", ctx)();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(posts.length, 2, "no further parts after the failing one");
  assert.strictEqual(res.sent, 1);
  assert.ok(/^part 2\/\d+ \(1 sent\): rate limited/.test(res.error), res.error);
  console.log("  OK  a failing part stops the run and reports which part / how many went out");
}

(async () => {
  console.log("Running bug-report chunking tests (no real browser, no network)...\n");
  try {
    await testSmallLogIsOneRequestUnchanged();
    await testFullBufferSplitsIntoBoundedPartsLosslessly();
    await testLifecycleLinesSurviveAFloodOfOrdinaryLines();
    await testLifecycleBufferIsBoundedButIndependent();
    await testEscapeHeavyLogStillFitsOnTheWire();
    await testSingleGiantLineIsSlicedNotDropped();
    await testStopsAtFirstFailureAndSaysWhere();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.message);
    process.exit(1);
  }
})();
