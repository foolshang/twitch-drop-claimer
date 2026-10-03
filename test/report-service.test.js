/**
 * report-service.test.js - runs the Python tests of the bug-report relay (report-service/test_main.py):
 * non-object JSON, the code fence, version/lang checks, per-client limits that count only valid reports (a
 * multi-part report once), the socket timeout and the connection cap. Skipped when no Python is installed.
 */

const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = path.join(__dirname, "..", "report-service");
const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];

let ran = false;
for (const py of candidates) {
  const probe = spawnSync(py, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) continue;
  console.log(`Running the relay's Python tests with ${py} (${(probe.stdout || probe.stderr).trim()})...\n`);
  const res = spawnSync(py, ["-m", "unittest", "test_main", "-v"], { cwd: dir, encoding: "utf8", timeout: 120_000 });
  const lines = `${res.stdout || ""}${res.stderr || ""}`.split(/\r?\n/).filter((l) => /^(test_| *test_|Ran |OK|FAILED|FAIL:|ERROR:)/.test(l) || /\.\.\. (ok|FAIL|ERROR|skipped)/.test(l));
  console.log(lines.map((l) => "  " + l.replace(/ \.\.\. 127\.0\.0\.1.*$/, " ...")).join("\n"));
  assert.strictEqual(res.status, 0, `the relay tests failed:\n${res.stderr}`);
  ran = true;
  break;
}
if (!ran) console.log("No Python found - the relay tests were skipped.");
console.log("\nALL PASSED");
