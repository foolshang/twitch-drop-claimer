#!/usr/bin/env node
/**
 * submit-amo.js - bump -> lint -> build -> sign workflow for AMO submissions.
 *
 * Usage:
 *   node scripts/submit-amo.js [--bump=patch|minor|major] [--listed]
 *                               [--skip-version-check] [--dry-run]
 *
 * Credentials are NEVER hardcoded here - set them in the environment before
 * running (PowerShell: $env:AMO_JWT_ISSUER = "..."):
 *   AMO_JWT_ISSUER  - AMO API key (issuer)
 *   AMO_JWT_SECRET  - AMO API secret
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
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const EXTENSION_FILES = [
  "manifest.json",
  "shared.js",
  "background.js",
  "content.js",
  "popup.html",
  "popup.js",
];
const GECKO_ID = "twitch-drop-auto-claimer@foolshang";
const LEDGER_PATH = path.join(ROOT, ".amo-submitted-versions.json");
const ARTIFACTS_DIR = path.join(ROOT, "web-ext-artifacts");

function parseArgs(argv) {
  const args = { bump: null, listed: false, skipVersionCheck: false, dryRun: false };
  for (const a of argv) {
    if (a.startsWith("--bump=")) args.bump = a.split("=")[1];
    else if (a === "--listed") args.listed = true;
    else if (a === "--skip-version-check") args.skipVersionCheck = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  if (args.bump && !["patch", "minor", "major"].includes(args.bump)) {
    console.error(`Invalid --bump value: ${args.bump} (expected patch|minor|major)`);
    process.exit(1);
  }
  return args;
}

function printHelp() {
  console.log(`
submit-amo.js - bump -> lint -> build -> sign

  --bump=patch|minor|major   bump manifest.json version before building (default: no bump)
  --listed                   sign to the public "listed" channel (default: unlisted)
  --skip-version-check       skip the pre-flight "already submitted?" check (use with care)
  --dry-run                  run bump/lint/build only, never calls web-ext sign

Required env vars for an actual sign (not needed for --dry-run):
  AMO_JWT_ISSUER, AMO_JWT_SECRET
`);
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
  console.log(`Source tree OK: ${real}`);
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
  console.log(`Bumped version: ${oldVersion} -> ${manifest.version}`);
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
  console.log(`Staged ${EXTENSION_FILES.length} files -> ${stageDir}`);
  return stageDir;
}

// ---- run web-ext via npx (no local dependency needed) ----------------------
// Windows needs shell:true to resolve npx.cmd at all. All arguments passed
// here are self-generated (fixed flags, paths built with path.join) except
// the AMO credentials in the final `sign` call, which come from env vars the
// user set themselves - not untrusted external input - so Node's built-in
// argv escaping for the shell:true + args-array form is an acceptable
// trade-off versus npx.cmd's own path-resolution logic breaking under manual
// re-quoting (verified: manual quoting made npx.cmd mis-resolve its own
// install location).
function runWebExt(args, { allowFailure = false } = {}) {
  console.log(`\n$ npx --yes web-ext ${args.join(" ")}`);
  const res = spawnSync("npx", ["--yes", "web-ext", ...args], { stdio: "inherit", shell: true });
  if (res.status !== 0 && !allowFailure) {
    throw new Error(`web-ext ${args[0]} failed with exit code ${res.status}`);
  }
  return res.status === 0;
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

async function assertVersionNotAlreadySubmitted(version, issuer, secret) {
  // local ledger first - works even without network/credentials
  const ledger = fs.existsSync(LEDGER_PATH) ? JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")) : [];
  if (ledger.some((e) => e.version === version)) {
    throw new Error(`Version ${version} is already in the local submit ledger (${LEDGER_PATH}). Bump the version first.`);
  }

  if (!issuer || !secret) {
    console.log("No AMO credentials in env - skipping the remote version-history check (local ledger check passed).");
    return;
  }

  const token = signJwt(issuer, secret);
  const url = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(GECKO_ID)}/versions/`;
  let res;
  try {
    res = await apiGet(url, token);
  } catch (e) {
    throw new Error(`Could not reach AMO API to check existing versions: ${e.message} (use --skip-version-check to bypass)`);
  }

  if (res.status === 404) {
    console.log("AMO has no record of this add-on yet - nothing to collide with.");
    return;
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`AMO version-history check failed: HTTP ${res.status} - ${res.body.slice(0, 300)}`);
  }

  let data;
  try { data = JSON.parse(res.body); } catch { data = null; }
  const versions = (data && (data.results || data)) || [];
  const existing = versions.map((v) => v.version).filter(Boolean);
  if (existing.includes(version)) {
    throw new Error(`Version ${version} was already submitted to AMO. Bump the version (--bump=patch) before signing.`);
  }
  console.log(`AMO version-history check passed (${existing.length} versions on record, ${version} not among them).`);
}

function recordLedger(version, channel) {
  const ledger = fs.existsSync(LEDGER_PATH) ? JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")) : [];
  ledger.push({ version, channel, at: new Date().toISOString() });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertCorrectSourceTree();

  const version = applyBump(args.bump);
  const channel = args.listed ? "listed" : "unlisted";
  console.log(`\nTarget version: ${version}   channel: ${channel}${args.dryRun ? "   (dry run)" : ""}`);

  const stageDir = stageSource();

  runWebExt(["lint", "--source-dir", stageDir]);
  runWebExt(["build", "--source-dir", stageDir, "--artifacts-dir", ARTIFACTS_DIR, "--overwrite-dest"]);

  if (!args.skipVersionCheck) {
    await assertVersionNotAlreadySubmitted(version, process.env.AMO_JWT_ISSUER, process.env.AMO_JWT_SECRET);
  } else {
    console.log("Skipping version-duplicate check (--skip-version-check).");
  }

  if (args.dryRun) {
    console.log("\n--dry-run: stopping before web-ext sign. Lint + build succeeded.");
    return;
  }

  const issuer = process.env.AMO_JWT_ISSUER;
  const secret = process.env.AMO_JWT_SECRET;
  if (!issuer || !secret) {
    throw new Error("AMO_JWT_ISSUER / AMO_JWT_SECRET are not set in the environment. Set them first, or use --dry-run.");
  }

  if (args.listed) {
    console.log("\n*** Signing to the PUBLIC LISTED channel (--listed was passed explicitly) ***");
  }

  runWebExt([
    "sign",
    "--source-dir", stageDir,
    "--artifacts-dir", ARTIFACTS_DIR,
    "--api-key", issuer,
    "--api-secret", secret,
    "--channel", channel,
  ]);

  recordLedger(version, channel);
  console.log(`\nSigned and recorded version ${version} (${channel}) in ${LEDGER_PATH}`);
}

main().catch((e) => {
  console.error(`\nsubmit-amo.js failed: ${e.message}`);
  process.exit(1);
});
