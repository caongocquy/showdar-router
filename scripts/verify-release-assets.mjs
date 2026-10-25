#!/usr/bin/env node

// Release artifact completeness gate.
//
// Runs before any asset is attached to a GitHub Release. Requires EXACTLY the
// four expected platform archives, each with exactly one matching .sha256, and
// verifies every archive/checksum pair. Rejects missing, unexpected and
// duplicate assets so a partially-produced or mixed-up release cannot ship.
//
// The expected set is the single source of truth; the release-artifacts.yml
// matrix must produce exactly these names.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const EXPECTED_ARCHIVES = [
  "showdar-router-darwin-arm64.tar.gz",
  "showdar-router-darwin-x64.tar.gz",
  "showdar-router-linux-x64.tar.gz",
  "showdar-router-windows-x64.zip",
];

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
const dir = path.resolve(args.dir ?? "release-assets");
if (!fs.existsSync(dir)) fail(`Asset directory not found: ${dir}`);
if (!fs.statSync(dir).isDirectory()) fail(`Asset path is not a directory: ${dir}`);

// Flat layout is required: nested directories mean the platform artifacts were
// not merged, which hides per-platform duplicates instead of rejecting them.
const nested = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
if (nested.length > 0) {
  fail(`Unexpected nested directories under ${dir}: ${nested.map((e) => e.name).join(", ")} (artifacts must be merged flat)`);
}

const expectedChecksums = EXPECTED_ARCHIVES.map((name) => `${name}.sha256`);
const expected = new Set([...EXPECTED_ARCHIVES, ...expectedChecksums]);
const present = new Set(fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile()));

const missing = [...expected].filter((name) => !present.has(name));
const unexpected = [...present].filter((name) => !expected.has(name));
if (missing.length > 0) fail(`Missing release assets: ${missing.join(", ")}`);
if (unexpected.length > 0) fail(`Unexpected release assets: ${unexpected.join(", ")}`);
if (present.size !== expected.size) fail(`Expected exactly ${expected.size} asset files, found ${present.size}`);

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

for (const archive of EXPECTED_ARCHIVES) {
  const archivePath = path.join(dir, archive);
  const checksumPath = path.join(dir, `${archive}.sha256`);

  const recorded = fs.readFileSync(checksumPath, "utf8").trim().split(/\s+/);
  if (recorded.length < 2 || !/^[0-9a-f]{64}$/i.test(recorded[0])) {
    fail(`Malformed checksum file: ${archive}.sha256`);
  }
  // The checksum must name the archive it belongs to, otherwise a checksum
  // copied from another platform would silently validate the wrong file.
  if (path.basename(recorded[1]) !== archive) {
    fail(`Checksum ${archive}.sha256 references ${recorded[1]}, expected ${archive}`);
  }

  const actual = sha256(archivePath);
  if (actual !== recorded[0].toLowerCase()) {
    fail(`Checksum mismatch for ${archive}: file ${actual}, expected ${recorded[0].toLowerCase()}`);
  }
  console.log(`release asset verified: ${archive} (${actual})`);
}

console.log(`release assets OK (${EXPECTED_ARCHIVES.length} archives, ${expectedChecksums.length} checksums) in ${dir}`);
