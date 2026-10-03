/**
 * submit-amo.test.js - finding D5 of the 0.6.24 code review (scripts/submit-amo.js)
 *
 *  - the duplicate-version check read only the first page of AMO's versions list and not the unlisted ones;
 *  - redaction worked per output chunk: a secret split across two chunks leaked;
 *  - shell:true only concatenated the arguments into a command line.
 *
 * The script is importable (main() runs only when it is the entry point). No network.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const amo = require("../scripts/submit-amo.js");

const SECRET = "s3cr3t-VALUE-0123456789";

function testRedactionAcrossChunks() {
  // the old way: each chunk on its own
  const naive = (chunks) => chunks.map((c) => amo.redactWith([SECRET], c)).join("");
  const split = ["...key is s3cr3t-VAL", "UE-0123456789 and more"];
  assert.ok(naive(split).includes("s3cr3t-VAL"), "sanity: redacting chunk by chunk leaks a secret split across two chunks");

  const out = [];
  const r = amo.makeStreamRedactor([SECRET], (t) => out.push(t));
  for (const c of split) r.push(c);
  r.flush();
  const text = out.join("");
  assert.ok(!text.includes("s3cr3t"), "the stream redactor never lets a part of the secret through: " + text);
  assert.ok(text.includes("[REDACTED]") && text.includes("...key is ") && text.includes(" and more"), "the rest is kept: " + text);

  // split at every possible position, and byte-by-byte
  for (let i = 1; i < SECRET.length; i++) {
    const o = [];
    const rr = amo.makeStreamRedactor([SECRET], (t) => o.push(t));
    const full = `before ${SECRET} after`;
    const at = 7 + i;
    rr.push(full.slice(0, at)); rr.push(full.slice(at)); rr.flush();
    assert.strictEqual(o.join(""), "before [REDACTED] after", `split at ${i}`);
  }
  const o2 = [];
  const r2 = amo.makeStreamRedactor([SECRET, "other-secret"], (t) => o2.push(t));
  for (const ch of `x ${SECRET} y other-secret z`) r2.push(ch);
  r2.flush();
  assert.strictEqual(o2.join(""), "x [REDACTED] y [REDACTED] z");
  // with nothing to hide it just passes text through
  const o3 = [];
  const r3 = amo.makeStreamRedactor([], (t) => o3.push(t));
  r3.push("hello "); r3.push("world"); r3.flush();
  assert.strictEqual(o3.join(""), "hello world");
  console.log("  OK  D5: a secret split across output chunks (at any position) is redacted; the rest is kept");
}

function testNoShellAndArgumentsStayIntact() {
  const nasty = 'a b & c "d" $HOME `x` ; | > <';
  const { command, args } = amo.webExtCommand(["sign", "--api-secret", nasty]);
  assert.strictEqual(command, process.execPath, "node runs web-ext's script directly - no .cmd shim, no shell");
  assert.ok(/web-ext[\\/]bin[\\/]web-ext\.js$/.test(args[0]), args[0]);
  assert.strictEqual(args[args.length - 1], nasty, "the argument is passed as one element, unquoted and unchanged");
  assert.ok(fs.existsSync(args[0]), "web-ext's script exists: " + args[0]);
  // what a child receives (the same spawn form, no shell)
  const res = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...args.slice(1)], { encoding: "utf8" });
  assert.deepStrictEqual(JSON.parse(res.stdout), args.slice(1), "arguments with spaces, quotes and shell characters arrive intact");
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "submit-amo.js"), "utf8");
  const code = src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join(" "); // comments may mention it
  assert.ok(!/shell:\s*true/.test(code), "no shell:true left in the code");
  const ver = spawnSync(command, [...amo.webExtCommand(["--version"]).args], { encoding: "utf8" });
  assert.strictEqual(ver.status, 0, "web-ext runs this way: " + (ver.stderr || ""));
  console.log("  OK  D5: web-ext runs through node without a shell; arguments with special characters arrive intact");
}

function amoPage(versions, next) {
  return { status: 200, body: JSON.stringify({ results: versions.map((v) => ({ version: v })), next }) };
}

async function testTheVersionCheckReadsEveryPageAndUnlisted() {
  const requested = [];
  const p2 = "https://addons.mozilla.org/api/v5/addons/addon/x/versions/?page=2&filter=all_with_unlisted";
  const p3 = "https://addons.mozilla.org/api/v5/addons/addon/x/versions/?page=3&filter=all_with_unlisted";
  const get = async (url) => {
    requested.push(url);
    if (!/page=/.test(url)) return amoPage(["0.6.2", "0.6.3"], p2);
    if (/page=2/.test(url)) return amoPage(["0.6.4"], p3);
    return amoPage(["0.6.24"], null); // the version we are about to submit is on the LAST page
  };
  const ledger = path.join(os.tmpdir(), "no-such-ledger.json");
  await assert.rejects(
    () => amo.assertVersionNotAlreadySubmitted("0.6.24", "issuer", "secret", { ledgerPath: ledger, get }),
    /already submitted to AMO/,
    "a version on the last page is found"
  );
  assert.strictEqual(requested.length, 3, "every page was read: " + JSON.stringify(requested));
  assert.ok(requested[0].includes("filter=" + amo.AMO_VERSIONS_FILTER), "unlisted versions are asked for: " + requested[0]);
  assert.strictEqual(amo.AMO_VERSIONS_FILTER, "all_with_unlisted");

  // a version that is on no page passes
  const get2 = async (url) => (/page=2/.test(url) ? amoPage(["0.6.4"], null) : amoPage(["0.6.2"], p2));
  await amo.assertVersionNotAlreadySubmitted("0.6.99", "issuer", "secret", { ledgerPath: ledger, get: get2 });

  // the JWT is never sent to another host
  const evil = async () => amoPage(["0.6.2"], "https://evil.example/steal");
  await assert.rejects(() => amo.assertVersionNotAlreadySubmitted("0.6.99", "issuer", "secret", { ledgerPath: ledger, get: evil }), /another host/);
  // an unknown add-on (404 on the first page) has nothing to collide with
  await amo.assertVersionNotAlreadySubmitted("0.0.1", "issuer", "secret", { ledgerPath: ledger, get: async () => ({ status: 404, body: "" }) });
  console.log("  OK  D5: the version check follows every page, includes unlisted versions and keeps the JWT on addons.mozilla.org");
}

function testReleaseNotesGoIntoTheListedMetadata() {
  const f = path.join(os.tmpdir(), "notes-test.md");
  fs.writeFileSync(f, ["Release notes for X - paste into the field.", "", "-".repeat(40), "", "0.6.26", "", "FIXED", "- a thing", ""].join("\n"));
  const { meta, path: out } = amo.buildListedMetadata(f);
  assert.strictEqual(meta.version.release_notes["en-US"], "0.6.26\n\nFIXED\n- a thing", "the part above the dashes is not part of the notes");
  assert.strictEqual(meta.version.license, "MPL-2.0", "the fixed metadata is kept");
  assert.strictEqual(JSON.parse(fs.readFileSync(out, "utf8")).version.release_notes["en-US"], meta.version.release_notes["en-US"]);
  assert.strictEqual(amo.buildListedMetadata(null).meta.version.release_notes, undefined, "no notes file = unchanged metadata");
  console.log("  OK  release notes file -> version.release_notes (en-US) in the AMO metadata");
}

(async () => {
  console.log("Running submit-amo tests...\n");
  try {
    testReleaseNotesGoIntoTheListedMetadata();
    testRedactionAcrossChunks();
    testNoShellAndArgumentsStayIntact();
    await testTheVersionCheckReadsEveryPageAndUnlisted();
    console.log("\nALL PASSED");
    process.exit(0);
  } catch (e) {
    console.error("\nFAILED:", e.stack || e.message);
    process.exit(1);
  }
})();
