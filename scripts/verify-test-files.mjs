#!/usr/bin/env node

// Centralized per-file test gate shared by ci.yml and release.yml.
//
// File existence alone is insufficient: vitest silently ignores CLI filters
// that match no file, so a renamed/moved suite could drop required coverage
// while the remaining suites keep the step green. For every expected file this
// asserts: the file exists, vitest collected it, it executed >0 tests, and it
// had 0 failures. A missing or unreadable JSON report fails the gate too.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) fail(`Invalid argument list near ${key ?? "<end>"}`);
    values[key.slice(2)] = value;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
if (!args.list) fail("Missing --list <file>");
if (!fs.existsSync(args.list)) fail(`Test list not found: ${args.list}`);

const expected = fs
  .readFileSync(args.list, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
if (expected.length === 0) fail(`Test list is empty: ${args.list}`);

for (const file of expected) {
  if (!fs.existsSync(file)) fail(`Expected test file missing: ${file}`);
}

const reportPath = args.report || path.join(os.tmpdir(), `showdar-vitest-report-${process.pid}.json`);
const isWindows = process.platform === "win32";
const npx = isWindows ? "npx.cmd" : "npx";
const result = spawnSync(
  npx,
  ["vitest", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`, ...expected],
  { stdio: "inherit", shell: isWindows },
);
const vitestExit = result.status ?? 1;

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
} catch (error) {
  fail(`Test report missing or unreadable: ${error.message}`);
}

const results = Array.isArray(report.testResults) ? report.testResults : [];
const byName = new Map(results.map((entry) => [entry.name.replace(/^.*[\\/]tests[\\/]/, "tests/"), entry]));

let ok = true;
for (const file of expected) {
  const entry = byName.get(file);
  if (!entry) {
    console.error(`::error::Expected test file collected zero tests: ${file}`);
    ok = false;
    continue;
  }
  const assertions = Array.isArray(entry.assertionResults) ? entry.assertionResults : [];
  const executed = assertions.filter((a) => a.status !== "skipped").length;
  const failed = assertions.filter((a) => a.status === "failed").length;
  console.log(`test gate: ${file} -> ${executed} executed, ${failed} failed`);
  if (executed === 0) {
    console.error(`::error::Expected test file collected zero tests: ${file}`);
    ok = false;
  }
  if (failed > 0) {
    console.error(`::error::Expected test file has failing tests: ${file}`);
    ok = false;
  }
}

try {
  fs.rmSync(reportPath, { force: true });
} catch {
  /* best effort */
}

if (vitestExit !== 0 || !ok) fail(`Test gate failed (vitest_exit=${vitestExit})`);
console.log(`test gate: PASS (${expected.length} files)`);
