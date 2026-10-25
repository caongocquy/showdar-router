import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let testApi;
try {
  testApi = await import("vitest");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  testApi = await import("node:test");
}
const { afterEach, describe, it } = testApi;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, "scripts", "verify-release-assets.mjs");

const ARCHIVES = [
  "showdar-router-darwin-arm64.tar.gz",
  "showdar-router-darwin-x64.tar.gz",
  "showdar-router-linux-x64.tar.gz",
  "showdar-router-windows-x64.zip",
];

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-release-assets-"));
  tempDirs.push(dir);
  return dir;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function writeArchive(dir, name, contents = name) {
  const buffer = Buffer.from(contents);
  fs.writeFileSync(path.join(dir, name), buffer);
  fs.writeFileSync(path.join(dir, `${name}.sha256`), `${sha256(buffer)}  ${name}\n`);
}

function completeDir() {
  const dir = tempDir();
  for (const name of ARCHIVES) writeArchive(dir, name);
  return dir;
}

function run(dir) {
  return spawnSync(process.execPath, [script, "--dir", dir], { encoding: "utf8" });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("release asset completeness gate", () => {
  it("accepts exactly the four expected archives with matching checksums", () => {
    const result = run(completeDir());
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /release assets OK \(4 archives, 4 checksums\)/);
  });

  it("rejects a missing archive", () => {
    const dir = completeDir();
    fs.rmSync(path.join(dir, ARCHIVES[2]));
    const result = run(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing release assets:.*showdar-router-linux-x64\.tar\.gz/);
  });

  it("rejects a missing checksum", () => {
    const dir = completeDir();
    fs.rmSync(path.join(dir, `${ARCHIVES[0]}.sha256`));
    const result = run(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing release assets:.*darwin-arm64\.tar\.gz\.sha256/);
  });

  it("rejects an unexpected extra asset", () => {
    const dir = completeDir();
    fs.writeFileSync(path.join(dir, "showdar-router-freebsd-x64.tar.gz"), "x");
    const result = run(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected release assets:.*freebsd/);
  });

  it("rejects a checksum mismatch", () => {
    const dir = completeDir();
    fs.writeFileSync(path.join(dir, ARCHIVES[1]), "tampered");
    const result = run(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Checksum mismatch for showdar-router-darwin-x64\.tar\.gz/);
  });

  it("rejects a checksum that names a different archive", () => {
    const dir = completeDir();
    const buffer = fs.readFileSync(path.join(dir, ARCHIVES[0]));
    fs.writeFileSync(path.join(dir, `${ARCHIVES[0]}.sha256`), `${sha256(buffer)}  ${ARCHIVES[3]}\n`);
    const result = run(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /references showdar-router-windows-x64\.zip/);
  });

  it("rejects a malformed checksum", () => {
    const dir = completeDir();
    fs.writeFileSync(path.join(dir, `${ARCHIVES[0]}.sha256`), "not-a-hash\n");
    const result = run(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Malformed checksum file/);
  });

  it("rejects nested (unmerged) artifact directories", () => {
    const dir = completeDir();
    fs.mkdirSync(path.join(dir, "darwin-arm64"));
    const result = run(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected nested directories/);
  });

  it("rejects a missing asset directory", () => {
    const result = run(path.join(tempDir(), "absent"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Asset directory not found/);
  });
});
