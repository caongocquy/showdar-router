#!/usr/bin/env node

// Isolated install smoke for the published CLI tarball.
//
// Packs cli/, installs the tarball with --ignore-scripts into a throwaway
// --prefix OUTSIDE the repository, then asserts the installed package is
// self-contained and runs from an unrelated cwd with a clean environment.
//
// Determinism: SHOWDAR_ROUTER_SKIP_RUNTIME_INSTALL=1 disables the postinstall/
// runtime self-heal so no package is fetched at run time. Because scripts are
// skipped and self-heal is disabled, these are intentionally NOT exercised
// here (covered by cli-build-artifacts / cli-tray-behavioral tests instead):
//   - better-sqlite3 native install (DB falls back to built-in node:sqlite)
//   - sql.js reinstall into ~/.showdar-router/runtime
//   - systray2 tray install (macOS/Linux)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = path.join(repo, "cli");
const version = JSON.parse(fs.readFileSync(path.join(cliDir, "package.json"), "utf8")).version;

assert.ok(
  fs.existsSync(path.join(cliDir, "app", "custom-server.js")),
  "cli/app build output missing; run `npm --prefix cli run build` before this smoke",
);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-router-npm-smoke-"));
const packDir = path.join(work, "pack");
const prefix = path.join(work, "prefix");
const home = path.join(work, "home");
const dataDir = path.join(work, "data");
for (const dir of [packDir, prefix, home, dataDir]) fs.mkdirSync(dir, { recursive: true });

const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";
const installEnv = { ...process.env, npm_config_cache: path.join(work, "npm-cache") };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { shell: isWindows, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  return result;
}

try {
  const packResult = spawnSync(npm, ["pack", "--json", "--pack-destination", packDir], {
    cwd: cliDir,
    encoding: "utf8",
    shell: isWindows,
    env: installEnv,
  });
  if (packResult.status !== 0) {
    process.stderr.write(packResult.stderr ?? "");
    throw new Error("npm pack failed");
  }
  const tarball = path.join(packDir, JSON.parse(packResult.stdout)[0].filename);
  assert.ok(fs.existsSync(tarball), `packed tarball missing: ${tarball}`);

  run(npm, ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    env: installEnv,
    stdio: "inherit",
  });

  const installed = isWindows
    ? path.join(prefix, "node_modules", "showdar-router")
    : path.join(prefix, "lib", "node_modules", "showdar-router");
  assert.ok(fs.existsSync(installed), `installed package not found: ${installed}`);

  // Self-contained: entry, hooks, app and the MITM bundle all live in the package.
  for (const rel of [
    "cli.js",
    "hooks/postinstall.js",
    "hooks/sqliteRuntime.js",
    "app/custom-server.js",
    "app/server.js",
    "app/src/mitm/server.js",
  ]) {
    assert.ok(fs.existsSync(path.join(installed, ...rel.split("/"))), `installed package missing ${rel}`);
  }

  // MITM ships only the esbuild bundle, never plain source siblings.
  const mitmDir = path.join(installed, "app", "src", "mitm");
  assert.deepEqual(
    fs.readdirSync(mitmDir).filter((name) => name.endsWith(".js")).sort(),
    ["server.js"],
    "app/src/mitm must contain only the built server.js bundle",
  );

  // Run the installed entry from OUTSIDE the repo with isolated HOME/config.
  const runEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    DATA_DIR: dataDir,
    SHOWDAR_ROUTER_SKIP_RUNTIME_INSTALL: "1",
    CI: "true",
  };
  const versionResult = spawnSync(process.execPath, [path.join(installed, "cli.js"), "--version"], {
    cwd: work,
    encoding: "utf8",
    env: runEnv,
  });
  assert.equal(versionResult.status, 0, `installed CLI --version failed: ${versionResult.stderr}`);
  assert.equal(versionResult.stdout.trim(), version, `installed CLI reported ${versionResult.stdout.trim()}, expected ${version}`);

  console.log(`npm install smoke: PASS (showdar-router@${version}, isolated prefix ${prefix})`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
