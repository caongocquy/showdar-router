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
const { afterEach, describe, it, vi } = testApi;

const require = createRequire(import.meta.url);
const sqliteRuntime = require("../../cli/hooks/sqliteRuntime.js");
const { ensureTrayRuntime } = require("../../cli/hooks/trayRuntime.js");
const { ensureSqliteRuntime, getRuntimeDir, getRuntimeNodeModules, summarizeNpmError } = sqliteRuntime;

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

const savedEnv = {
  DATA_DIR: process.env.DATA_DIR,
  SHOWDAR_ROUTER_DATA_DIR: process.env.SHOWDAR_ROUTER_DATA_DIR,
  APPDATA: process.env.APPDATA,
  PATH: process.env.PATH,
  SKIP: process.env.SHOWDAR_ROUTER_SKIP_RUNTIME_INSTALL,
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (savedEnv.DATA_DIR === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = savedEnv.DATA_DIR;
  if (savedEnv.SHOWDAR_ROUTER_DATA_DIR === undefined) delete process.env.SHOWDAR_ROUTER_DATA_DIR; else process.env.SHOWDAR_ROUTER_DATA_DIR = savedEnv.SHOWDAR_ROUTER_DATA_DIR;
  if (savedEnv.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = savedEnv.APPDATA;
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

describe("runtime data dir precedence", () => {
  it("prefers SHOWDAR_ROUTER_DATA_DIR when both variables are set", () => {
    const primary = tempDir();
    const legacy = tempDir();
    process.env.SHOWDAR_ROUTER_DATA_DIR = primary;
    process.env.DATA_DIR = legacy;

    assert.equal(getRuntimeDir(), path.join(primary, "runtime"));
    assert.equal(getRuntimeNodeModules(), path.join(primary, "runtime", "node_modules"));
  });

  it("honours SHOWDAR_ROUTER_DATA_DIR alone", () => {
    const dir = tempDir();
    process.env.SHOWDAR_ROUTER_DATA_DIR = dir;
    delete process.env.DATA_DIR;

    assert.equal(getRuntimeDir(), path.join(dir, "runtime"));
  });

  it("still honours DATA_DIR alone for existing installations", () => {
    const dir = tempDir();
    process.env.DATA_DIR = dir;
    delete process.env.SHOWDAR_ROUTER_DATA_DIR;

    assert.equal(getRuntimeDir(), path.join(dir, "runtime"));
  });

  it("falls back to the platform default runtime when neither variable is set", () => {
    delete process.env.DATA_DIR;
    delete process.env.SHOWDAR_ROUTER_DATA_DIR;

    const expected = process.platform === "win32"
      ? path.join(process.env.APPDATA || os.homedir(), "showdar-router", "runtime")
      : path.join(os.homedir(), ".showdar-router", "runtime");

    assert.equal(getRuntimeDir(), expected);
  });

  it("uses APPDATA on Windows and ignores it elsewhere", () => {
    delete process.env.DATA_DIR;
    delete process.env.SHOWDAR_ROUTER_DATA_DIR;
    const appData = tempDir();
    process.env.APPDATA = appData;

    const expected = process.platform === "win32"
      ? path.join(appData, "showdar-router", "runtime")
      : path.join(os.homedir(), ".showdar-router", "runtime");

    assert.equal(getRuntimeDir(), expected);
  });

  it("degrades without throwing when the runtime dir cannot be created", () => {
    // Fault injection instead of chmod: chmod does not deny writes on Windows.
    if (!vi) return; // node:test fallback has no spy support
    const dir = tempDir();
    process.env.SHOWDAR_ROUTER_DATA_DIR = dir;
    process.env.DATA_DIR = dir;
    delete process.env.SHOWDAR_ROUTER_SKIP_RUNTIME_INSTALL;
    const denied = Object.assign(new Error(`EACCES: permission denied, mkdir '${path.join(dir, "runtime")}'`), { code: "EACCES" });
    const spy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => { throw denied; });

    try {
      const result = ensureTrayRuntime({ silent: true, platform: "darwin" });
      assert.equal(result.systray, false);
      assert.equal(result.error?.code, "EACCES");
    } finally {
      spy.mockRestore();
    }
  });

  it("degrades without throwing when the runtime path is a file", () => {
    const dir = tempDir();
    process.env.SHOWDAR_ROUTER_DATA_DIR = dir;
    process.env.DATA_DIR = dir;
    delete process.env.SHOWDAR_ROUTER_SKIP_RUNTIME_INSTALL;
    fs.writeFileSync(path.join(dir, "runtime"), "not a directory");

    const result = ensureTrayRuntime({ silent: true, platform: "darwin" });

    assert.equal(result.systray, false);
    assert.equal(typeof result.error?.code, "string");
  });
});
