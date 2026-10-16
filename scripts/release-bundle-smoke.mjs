#!/usr/bin/env node

// Functional smoke for a built portable bundle (scripts/package-release-bundle.mjs).
//
// Goes past `--version`: the launcher shim runs, the bundled Node runtime boots
// the bundled Next standalone entry, a local endpoint answers, shutdown is
// clean, and no listener is orphaned afterwards. Uses an isolated HOME/DATA_DIR
// and an ephemeral port so it never touches a developer's real installation.
//
// This drives the bundled app entry directly (the same runtime + entry the
// launcher execs). The interactive launcher path is intentionally NOT used for
// the live server here: cli.js reaps any running showdar-router/next-server
// process on start, which is only safe on a dedicated CI runner. Launcher
// shim behavior is still asserted via `--version`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { request } from "node:http";
import { createServer as createProbeServer } from "node:net";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      console.error(`Invalid argument near ${key ?? "<end>"}`);
      process.exit(1);
    }
    values[key.slice(2)] = value;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const bundleDir = path.resolve(args.bundle ?? ".release/bundle");
const expectedVersion = args.version;
if (!expectedVersion) {
  console.error("Missing --version");
  process.exit(1);
}
if (!fs.existsSync(bundleDir)) {
  console.error(`Bundle not found: ${bundleDir}`);
  process.exit(1);
}

const isWindows = process.platform === "win32";
const runtimePath = path.join(bundleDir, "runtime", isWindows ? "node.exe" : "node");
const packageDir = path.join(bundleDir, "node_modules", "showdar-router");
const appDir = path.join(packageDir, "app");
const launcherPath = path.join(bundleDir, "bin", isWindows ? "showdar-router.cmd" : "showdar-router");

for (const required of [
  runtimePath,
  launcherPath,
  path.join(packageDir, "cli.js"),
  path.join(appDir, "custom-server.js"),
  path.join(appDir, "server.js"),
  path.join(appDir, "src", "mitm", "server.js"),
]) {
  assert.ok(fs.existsSync(required), `bundle missing ${required}`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-bundle-smoke-"));
const home = path.join(work, "home");
const dataDir = path.join(work, "data");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createProbeServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: pathname, timeout: 2000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("timeout", () => req.destroy(new Error(`request timeout: ${pathname}`)));
    req.on("error", reject);
    req.end();
  });
}

let child = null;
let exitInfo = null;
let logs = "";

function stop() {
  if (child && !exitInfo) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
process.once("SIGINT", () => { stop(); process.exit(130); });
process.once("SIGTERM", () => { stop(); process.exit(143); });

function childEnv(port) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    DATA_DIR: dataDir,
    SHOWDAR_ROUTER_DATA_DIR: dataDir,
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    SHOWDAR_ROUTER_SKIP_RUNTIME_INSTALL: "1",
    CI: "true",
  };
}

async function waitReady(port) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (exitInfo) {
      throw new Error(`[startup-failure] server exited before ready (code=${exitInfo.code} signal=${exitInfo.signal})\n${logs}`);
    }
    try {
      if ((await httpGet(port, "/api/health")) === 200) return;
    } catch {
      /* still starting */
    }
    await delay(200);
  }
  throw new Error(`[startup-failure] /api/health did not answer 200 within 45s\n${logs}`);
}

async function shutdownAndAssertNoOrphan(port) {
  assert.ok(child && !exitInfo, "server process already exited before shutdown");
  child.kill(isWindows ? undefined : "SIGTERM");
  for (let i = 0; i < 60 && !exitInfo; i++) await delay(100);
  if (!exitInfo) {
    child.kill("SIGKILL");
    for (let i = 0; i < 30 && !exitInfo; i++) await delay(100);
  }
  assert.ok(exitInfo, "server did not exit after SIGTERM/SIGKILL");
  await delay(300);
  let stillListening = false;
  try {
    await httpGet(port, "/api/health");
    stillListening = true;
  } catch {
    /* expected: port released */
  }
  assert.equal(stillListening, false, "a process still answers on the port after shutdown (orphan listener)");
}

try {
  // Launcher shim launches the bundled runtime + entry outside the repo.
  const launcherResult = spawnSync(launcherPath, ["--version"], {
    cwd: work,
    encoding: "utf8",
    env: childEnv(1),
    shell: isWindows,
  });
  assert.equal(launcherResult.status, 0, `launcher --version failed: ${launcherResult.stderr}`);
  assert.equal(
    (launcherResult.stdout ?? "").trim(),
    expectedVersion,
    `launcher reported ${(launcherResult.stdout ?? "").trim()}, expected ${expectedVersion}`,
  );

  // Functional server boot via the bundled runtime + app entry.
  const port = await getFreePort();
  child = spawn(runtimePath, ["--dns-result-order=ipv4first", path.join(appDir, "custom-server.js"), "--port", String(port)], {
    cwd: appDir,
    env: childEnv(port),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  child.on("exit", (code, signal) => { exitInfo = { code, signal }; });
  child.on("error", (error) => {
    exitInfo = { code: null, signal: null };
    logs += `\nspawn error: ${error.message}`;
  });

  await waitReady(port);
  assert.equal(await httpGet(port, "/api/health"), 200, "GET /api/health");
  assert.equal(await httpGet(port, "/api/version"), 200, "GET /api/version");
  await shutdownAndAssertNoOrphan(port);

  console.log(`release bundle smoke: PASS (${bundleDir}, port ${port})`);
} finally {
  stop();
  fs.rmSync(work, { recursive: true, force: true });
}
