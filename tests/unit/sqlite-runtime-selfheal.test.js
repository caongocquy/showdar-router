import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

let testApi;
try {
  testApi = await import("vitest");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  testApi = await import("node:test");
}
const { afterEach, describe, it } = testApi;

const require = createRequire(import.meta.url);
const sqliteRuntime = require("../../cli/hooks/sqliteRuntime.js");
const { ensureSqliteRuntime, getRuntimeDir, summarizeNpmError } = sqliteRuntime;

const tempDirs = [];
function tempDir(prefix = "showdar-sqlite-selfheal-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// A stub `npm` on PATH: no network, exits with a chosen code and stderr. This
// exercises the real spawn/parse path offline, without touching the network or
// the developer's runtime directories.
function stubNpm({ exitCode = 1, stderr = "npm ERR! network getaddrinfo ENOTFOUND registry.npmjs.org" } = {}) {
  const dir = tempDir("showdar-stub-npm-");
  const isWindows = process.platform === "win32";
  const file = path.join(dir, isWindows ? "npm.cmd" : "npm");
  if (isWindows) {
    fs.writeFileSync(file, `@echo off\r\n>&2 echo ${stderr}\r\nexit /b ${exitCode}\r\n`);
  } else {
    fs.writeFileSync(file, `#!/bin/sh\necho "${stderr}" >&2\nexit ${exitCode}\n`);
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

const savedEnv = { DATA_DIR: process.env.DATA_DIR, PATH: process.env.PATH, SKIP: process.env.SHOWDAR_ROUTER_SKIP_RUNTIME_INSTALL };

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (savedEnv.DATA_DIR === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = savedEnv.DATA_DIR;
  if (savedEnv.PATH === undefined) delete process.env.PATH; else process.env.PATH = savedEnv.PATH;
  if (savedEnv.SKIP === undefined) delete process.env.SHOWDAR_ROUTER_SKIP_RUNTIME_INSTALL; else process.env.SHOWDAR_ROUTER_SKIP_RUNTIME_INSTALL = savedEnv.SKIP;
});

describe("sqlite runtime self-heal", () => {
  it("honours DATA_DIR for the user-writable runtime directory", () => {
    const dataDir = tempDir();
    process.env.DATA_DIR = dataDir;
    assert.equal(getRuntimeDir(), path.join(dataDir, "runtime"));
  });

  it("skip gate installs nothing and creates no runtime directory", () => {
    const dataDir = tempDir();
    process.env.DATA_DIR = dataDir;
    process.env.SHOWDAR_ROUTER_SKIP_RUNTIME_INSTALL = "1";

    const result = ensureSqliteRuntime({ silent: true });

    assert.equal(result.skipped, true);
    assert.equal(result.betterSqlite, false);
    assert.ok(!fs.existsSync(path.join(dataDir, "runtime")), "offline skip must not create the runtime dir");
  });

  it("degrades safely (no throw) when the optional native install fails", () => {
    const dataDir = tempDir();
    process.env.DATA_DIR = dataDir;
    delete process.env.SHOWDAR_ROUTER_SKIP_RUNTIME_INSTALL;
    process.env.PATH = `${stubNpm()}${path.delimiter}${savedEnv.PATH ?? ""}`;

    const result = ensureSqliteRuntime({ silent: true });

    assert.equal(result.betterSqlite, false, "a failed install must not report better-sqlite3 as ready");
    assert.equal(typeof result.sqlJs, "boolean");
    assert.equal(result.skipped, undefined);
  });

  it("classifies npm failures into user-facing reasons", () => {
    assert.match(summarizeNpmError("npm ERR! network getaddrinfo ENOTFOUND"), /internet connection|registry unreachable/i);
    assert.match(summarizeNpmError("npm ERR! EACCES permission denied"), /Permission denied/);
    assert.match(summarizeNpmError("npm ERR! ENOSPC no space left"), /disk space/);
    assert.match(summarizeNpmError("gyp ERR! find VS MSBuild"), /build tools/i);
    assert.match(summarizeNpmError("npm ERR! code ETARGET\nNo matching version"), /version not found/i);
    assert.equal(typeof summarizeNpmError(""), "string");
  });
});
