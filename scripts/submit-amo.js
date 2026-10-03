#!/usr/bin/env node
/**
 * submit-amo.js - bump -> lint -> build -> sign workflow for AMO submissions.
 *
 * Usage:
 *   node scripts/submit-amo.js [--bump=patch|minor|major] [--listed]
 *                               [--skip-version-check] [--dry-run]
 *
 * Credentials are NEVER hardcoded here - set them in the environment before
 * running (PowerShell: $env:AMO_JWT_ISSUER = "..."). Two name pairs are
 * accepted, checked in this order:
 *   AMO_JWT_ISSUER / AMO_JWT_SECRET      - preferred explicit names
 *   WEB_EXT_API_KEY / WEB_EXT_API_SECRET - the names web-ext's own --api-key/
 *                                          --api-secret flags are usually
 *                                          paired with; used as a fallback so
 *                                          credentials already set under
 *                                          web-ext's own convention just work
 *
 * Defaults to --channel=unlisted (self-distribution / testing). Publishing
 * to the public listed channel requires the explicit --listed flag - this
 * is never the default.
 *
 * The source is always resolved relative to this script's own location
 * (D:\Projects\twitch-drop-claimer), never a working directory guess, and a
 * hard assertion below refuses to run from anywhere under "Browser" (the
 * old, stale copy this project was migrated away from).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const crypto = require("crypto");
const { spawnSync, spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EXTENSION_FILES = [
  "manifest.json",
  "i18n.js",
  "shared.js",
  "background.js",
  "content.js",
  "gql-bridge.js",
  "inject.js",
  "popup.html",
  "popup.js",
];
const GECKO_ID = "twitch-drop-auto-claimer@foolshang";
const LEDGER_PATH = path.join(ROOT, ".amo-submitted-versions.json");
const ARTIFACTS_DIR = path.join(ROOT, "web-ext-artifacts");
const AMO_METADATA_PATH = path.join(ROOT, "scripts", "amo-metadata.json");

function parseArgs(argv) {
  const args = { bump: null, listed: false, skipVersionCheck: false, dryRun: false };
  for (const a of argv) {
    if (a.startsWith("--bump=")) args.bump = a.split("=")[1];
    else if (a === "--listed") args.listed = true;
    else if (a === "--skip-version-check") args.skipVersionCheck = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else { safeError(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  if (args.bump && !["patch", "minor", "major"].includes(args.bump)) {
    safeError(`Invalid --bump value: ${args.bump} (expected patch|minor|major)`);
    process.exit(1);
  }
  return args;
}

function printHelp() {
  safeLog(`
submit-amo.js - bump -> lint -> build -> sign

  --bump=patch|minor|major   bump manifest.json version before building (default: no bump)
  --listed                   sign to the public "listed" channel (default: unlisted)
  --skip-version-check       skip the pre-flight "already submitted?" check (use with care)
  --dry-run                  run bump/lint/build only, never calls web-ext sign

Required env vars for an actual sign (not needed for --dry-run):
  AMO_JWT_ISSUER / AMO_JWT_SECRET, or WEB_EXT_API_KEY / WEB_EXT_API_SECRET
`);
}

// AMO_JWT_ISSUER/SECRET take priority; WEB_EXT_API_KEY/SECRET (web-ext's own
// naming) are used as a fallback when the preferred names aren't set.
function getCredentials() {
  const issuer = process.env.AMO_JWT_ISSUER || process.env.WEB_EXT_API_KEY || "";
  const secret = process.env.AMO_JWT_SECRET || process.env.WEB_EXT_API_SECRET || "";
  const issuerSource = process.env.AMO_JWT_ISSUER ? "AMO_JWT_ISSUER" : process.env.WEB_EXT_API_KEY ? "WEB_EXT_API_KEY" : null;
  const secretSource = process.env.AMO_JWT_SECRET ? "AMO_JWT_SECRET" : process.env.WEB_EXT_API_SECRET ? "WEB_EXT_API_SECRET" : null;
  return { issuer, secret, issuerSource, secretSource };
}

// ============================================================================
// redaction safeguard - permanent, unconditional
// ============================================================================
// Every env var whose NAME looks like a credential (SECRET/KEY/TOKEN) has its
// VALUE registered here at startup, before anything else runs. safeLog/
// safeError below scrub every one of these values out of anything printed,
// no matter which code path produced the string - this is not specific to
// AMO_JWT_* / WEB_EXT_API_*, it covers any secret-shaped env var that exists
// in the process at all, including ones added later without updating this
// file.
const REDACTED_VALUES = Object.entries(process.env)
  .filter(([name, value]) => /SECRET|KEY|TOKEN/i.test(name) && value && value.length >= 6)
  .map(([, value]) => value);

function redactWith(values, str) {
  let out = String(str);
  for (const value of values) {
    out = out.split(value).join("[REDACTED]");
  }
  return out;
}

function redact(str) {
  return redactWith(REDACTED_VALUES, str);
}

// Redaction of a STREAM (a child process's output arrives in arbitrary chunks): redacting each chunk on its own
// lets a secret that is split across two chunks through. This holds back the last (longest secret - 1)
// characters - a secret cannot start earlier than that and still be incomplete - redacts everything it has, and
// writes out the rest; flush() at the end writes the held tail.
function makeStreamRedactor(values, write) {
  const usable = values.filter((v) => v && v.length > 0);
  const hold = Math.max(0, ...usable.map((v) => v.length)) - 1;
  let pending = "";
  return {
    push(text) {
      pending = redactWith(usable, pending + String(text));
      if (hold > 0 && pending.length > hold) {
        write(pending.slice(0, pending.length - hold));
        pending = pending.slice(pending.length - hold);
      } else if (hold <= 0) {
        write(pending);
        pending = "";
      }
    },
    flush() {
      if (pending) write(redactWith(usable, pending));
      pending = "";
    },
  };
}

function safeLog(...args) {
  console.log(...args.map(redact));
}

function safeError(...args) {
  console.error(...args.map(redact));
}

// ---- safety: refuse to ever run against the old D:\Browser copy ----------
function assertCorrectSourceTree() {
  const real = fs.realpathSync(ROOT);
  if (/[\\/]Browser[\\/]/i.test(real) || /[\\/]Browser$/i.test(real)) {
    throw new Error(`Refusing to build from a path under "Browser": ${real}`);
  }
  if (!/twitch-drop-claimer$/i.test(real)) {
    throw new Error(`Script is not located inside a "twitch-drop-claimer" folder: ${real}`);
  }
  for (const f of EXTENSION_FILES) {
    if (!fs.existsSync(path.join(ROOT, f))) {
      throw new Error(`Expected source file missing: ${f} (wrong source tree?)`);
    }
  }
  safeLog(`Source tree OK: ${real}`);
}

// ---- version bump ----------------------------------------------------------
function bumpVersion(version, level) {
  const parts = version.split(".").map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  let [major, minor, patch] = parts;
  if (level === "major") { major += 1; minor = 0; patch = 0; }
  else if (level === "minor") { minor += 1; patch = 0; }
  else { patch += 1; }
  return `${major}.${minor}.${patch}`;
}

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
}

function applyBump(bumpLevel) {
  if (!bumpLevel) return readManifest().version;
  const manifestPath = path.join(ROOT, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const oldVersion = manifest.version;
  manifest.version = bumpVersion(oldVersion, bumpLevel);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  safeLog(`Bumped version: ${oldVersion} -> ${manifest.version}`);
  return manifest.version;
}

// ---- staging copy: only the allowlisted extension files, never test/ etc ---
function stageSource() {
  const stageDir = path.join(os.tmpdir(), "twitch-drop-claimer-amo-build");
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  for (const f of EXTENSION_FILES) {
    fs.copyFileSync(path.join(ROOT, f), path.join(stageDir, f));
  }
  safeLog(`Staged ${EXTENSION_FILES.length} files -> ${stageDir}`);
  return stageDir;
}

// ---- run the locally-installed web-ext binary directly ---------------------
// Deliberately NOT going through `npx`/`npm exec`: npm writes its own debug
// log to disk (~/npm-cache/_logs/*-debug-N.log) containing the *full argv* of
// whatever it ran, on essentially every invocation - which previously wrote
// the plaintext --api-secret value straight to a file on disk, independent of
// anything this script itself printed. `web-ext` is now a devDependency
// (see package.json / `npm install`), so we call its binary in
// node_modules/.bin directly - a plain child process npm/npx never sees or
// logs.
// web-ext's own entry script, run by THIS node binary: no .cmd shim, so no shell is needed - with shell:true the
// arguments were only concatenated into a command line (a secret with a space, quote or & broke it or was
// interpreted by the shell). Now every argument reaches web-ext exactly as it is.
const WEB_EXT_BIN = path.join(ROOT, "node_modules", "web-ext", "bin", "web-ext.js");

function webExtCommand(args) {
  return { command: process.execPath, args: [WEB_EXT_BIN, ...args] };
}

function runWebExt(args, { allowFailure = false } = {}) {
  if (!fs.existsSync(WEB_EXT_BIN)) {
    throw new Error(`web-ext not found at ${WEB_EXT_BIN} - run "npm install" first.`);
  }
  safeLog(`\n$ web-ext ${redact(args.join(" "))}`);
  // (the only remaining exposure of a credential is this process's own argv list in memory, visible to e.g.
  // Task Manager while it runs - unavoidable for any CLI tool that takes credentials as flags)
  const { command, args: full } = webExtCommand(args);
  const res = spawnSync(command, full, { stdio: "inherit" });
  if (res.status !== 0 && !allowFailure) {
    throw new Error(`web-ext ${args[0]} failed with exit code ${res.status}`);
  }
  return res.status === 0;
}

// Same binary, but tees stdout/stderr to the console AND captures it, so the
// sign step can tell "AMO accepted the upload but is still manually
// reviewing it" (exit code 1, but not a real failure) apart from an actual
// signing error - a plain spawnSync+inherit can't be inspected after the
// fact, only streamed.
function runWebExtCaptured(args) {
  return new Promise((resolve, reject) => {
    safeLog(`\n$ web-ext ${redact(args.join(" "))}`);
    const { command, args: full } = webExtCommand(args);
    const child = spawn(command, full);
    let combined = "";
    const out = makeStreamRedactor(REDACTED_VALUES, (t) => process.stdout.write(t));
    const err = makeStreamRedactor(REDACTED_VALUES, (t) => process.stderr.write(t));
    child.stdout.on("data", (chunk) => { out.push(chunk.toString()); combined += chunk.toString(); });
    child.stderr.on("data", (chunk) => { err.push(chunk.toString()); combined += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => { out.flush(); err.flush(); resolve({ code, combined }); });
  });
}

// ---- minimal HS256 JWT signer, only used for the pre-flight version check --
// (the actual `web-ext sign` call builds its own JWT internally from
// --api-key/--api-secret; this one is only for our separate GET request to
// AMO's REST API)
function base64url(buf) {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signJwt(issuer, secret) {
  const header = base64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: issuer, jti: crypto.randomBytes(16).toString("hex"), iat: now, exp: now + 60,
  })));
  const sig = base64url(crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function apiGet(urlStr, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(urlStr, { method: "GET", headers: { Authorization: `JWT ${token}` } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// The versions endpoint is paginated (the first page is not everything) and by default lists only public listed
// versions: `filter=all_with_unlisted` includes the unlisted ones this project signs for testing (an AMO version
// number can never be reused, listed or not).
const AMO_VERSIONS_FILTER = "all_with_unlisted";

async function fetchAllAmoVersions(token, get = apiGet) {
  let url = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(GECKO_ID)}/versions/?filter=${AMO_VERSIONS_FILTER}&page_size=50`;
  const existing = [];
  for (let page = 0; url && page < 50; page++) {
    let res;
    try {
      res = await get(url, token);
    } catch (e) {
      throw new Error(`Could not reach AMO API to check existing versions: ${e.message} (use --skip-version-check to bypass)`);
    }
    if (res.status === 404 && page === 0) return null; // no add-on record yet
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`AMO version-history check failed: HTTP ${res.status} - ${res.body.slice(0, 300)}`);
    }
    let data;
    try { data = JSON.parse(res.body); } catch { data = null; }
    const results = (data && (Array.isArray(data) ? data : data.results)) || [];
    for (const v of results) if (v && v.version) existing.push(v.version);
    const next = data && !Array.isArray(data) ? data.next : null;
    // only ever follow a link to AMO itself (the JWT is sent with every request)
    if (next && new URL(next).origin !== "https://addons.mozilla.org") throw new Error(`AMO returned a next-page link to another host: ${next}`);
    url = next || null;
  }
  return existing;
}

async function assertVersionNotAlreadySubmitted(version, issuer, secret, { ledgerPath = LEDGER_PATH, get = apiGet } = {}) {
  // local ledger first - works even without network/credentials
  const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : [];
  if (ledger.some((e) => e.version === version)) {
    throw new Error(`Version ${version} is already in the local submit ledger (${ledgerPath}). Bump the version first.`);
  }

  if (!issuer || !secret) {
    safeLog("No AMO credentials in env - skipping the remote version-history check (local ledger check passed).");
    return;
  }

  const existing = await fetchAllAmoVersions(signJwt(issuer, secret), get);
  if (existing === null) {
    safeLog("AMO has no record of this add-on yet - nothing to collide with.");
    return;
  }
  if (existing.includes(version)) {
    throw new Error(`Version ${version} was already submitted to AMO. Bump the version (--bump=patch) before signing.`);
  }
  safeLog(`AMO version-history check passed (${existing.length} versions on record, ${version} not among them).`);
}

function recordLedger(version, channel, extra = {}) {
  const ledger = fs.existsSync(LEDGER_PATH) ? JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")) : [];
  ledger.push({ version, channel, at: new Date().toISOString(), ...extra });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertCorrectSourceTree();

  const version = applyBump(args.bump);
  const channel = args.listed ? "listed" : "unlisted";
  safeLog(`\nTarget version: ${version}   channel: ${channel}${args.dryRun ? "   (dry run)" : ""}`);

  const stageDir = stageSource();

  runWebExt(["lint", "--source-dir", stageDir]);
  runWebExt(["build", "--source-dir", stageDir, "--artifacts-dir", ARTIFACTS_DIR, "--overwrite-dest"]);

  const { issuer, secret, issuerSource, secretSource } = getCredentials();

  if (!args.skipVersionCheck) {
    await assertVersionNotAlreadySubmitted(version, issuer, secret);
  } else {
    safeLog("Skipping version-duplicate check (--skip-version-check).");
  }

  if (args.dryRun) {
    safeLog("\n--dry-run: stopping before web-ext sign. Lint + build succeeded.");
    return;
  }

  if (!issuer || !secret) {
    throw new Error(
      "No AMO credentials found. Set AMO_JWT_ISSUER/AMO_JWT_SECRET or WEB_EXT_API_KEY/WEB_EXT_API_SECRET, or use --dry-run."
    );
  }
  safeLog(`Using credentials from ${issuerSource} / ${secretSource}.`);

  if (args.listed) {
    safeLog("\n*** Signing to the PUBLIC LISTED channel (--listed was passed explicitly) ***");
  }

  const signArgs = [
    "sign",
    "--source-dir", stageDir,
    "--artifacts-dir", ARTIFACTS_DIR,
    "--api-key", issuer,
    "--api-secret", secret,
    "--channel", channel,
  ];
  // AMO requires a license on a listed add-on's first version - not needed
  // for unlisted, so only attach it when actually signing to listed.
  if (args.listed) {
    signArgs.push("--amo-metadata", AMO_METADATA_PATH);
  }
  const { code, combined } = await runWebExtCaptured(signArgs);

  if (code !== 0) {
    // A listed submission that passed validation but is awaiting manual
    // review isn't a failure - web-ext's CLI just gives up waiting for the
    // approval-timeout. Recognize that specific outcome instead of treating
    // it the same as a real signing error.
    if (/Approval:\s*timeout exceeded/i.test(combined)) {
      const urlMatch = combined.match(/https:\/\/addons\.mozilla\.org\S+/);
      const statusUrl = urlMatch ? urlMatch[0] : null;
      safeLog("\nUpload accepted and passed automated validation - now awaiting manual review on AMO.");
      if (statusUrl) safeLog(`Track status: ${statusUrl}`);
      recordLedger(version, channel, { pendingReview: true, statusUrl });
      return;
    }
    throw new Error(`web-ext sign failed with exit code ${code}`);
  }

  recordLedger(version, channel);
  safeLog(`\nSigned and recorded version ${version} (${channel}) in ${LEDGER_PATH}`);
}

if (require.main === module) {
  main().catch((e) => {
    safeError(`\nsubmit-amo.js failed: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { makeStreamRedactor, redactWith, webExtCommand, fetchAllAmoVersions, assertVersionNotAlreadySubmitted, AMO_VERSIONS_FILTER };
