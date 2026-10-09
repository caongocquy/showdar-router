import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer as createProbeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root derived from this script's own location (scripts/) — never
// process.cwd(), never a hardcoded absolute path.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = process.env.NEXT_DIST_DIR || ".next";
const standaloneDir = join(repo, distDir, "standalone");
const nextServerPath = join(standaloneDir, "server.js");
// Canonical standalone entry: postbuild (copy-standalone-assets.mjs) copies the
// trusted peer wrapper custom-server.js next to Next's server.js — same layout
// `npm run start:bun` and the published CLI package boot from.
const customServerPath = join(standaloneDir, "custom-server.js");
// CI builds root before running this smoke; set to reuse those artifacts
// instead of rebuilding.
const skipBuild = process.env.STANDALONE_SMOKE_SKIP_BUILD === "1";

const dataDir = mkdtempSync(join(tmpdir(), "showdar-router-runtime-"));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;
let childExit = null;
let logs = "";

// Pick an ephemeral free port so parallel runs never collide on a fixed port.
function getFreePort() {
  return new Promise((res, rej) => {
    const probe = createProbeServer();
    probe.once("error", rej);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((err) => (err ? rej(err) : res(port)));
    });
  });
}

function get(port, pathname) {
  return new Promise((resolveReq, rejectReq) => {
    const req = request({ hostname: "127.0.0.1", port, path: pathname, timeout: 2000 }, (res) => {
      res.resume();
      res.on("end", () => resolveReq(res.statusCode));
    });
    // Bound every request so a half-dead server cannot outwait the readiness
    // deadline by accepting connections and never responding.
    req.on("timeout", () => req.destroy(new Error(`request timeout: ${pathname}`)));
    req.on("error", rejectReq);
    req.end();
  });
}

// A missing build artifact is a build/packaging problem, distinct from the
// server failing to start. Fail with an explicit class so CI logs separate them.
function missingArtifact(path, hint) {
  throw new Error(`[missing-artifact] ${path} — ${hint}`);
}

function assertBuildArtifacts() {
  if (!existsSync(nextServerPath)) {
    missingArtifact(nextServerPath, skipBuild
      ? "STANDALONE_SMOKE_SKIP_BUILD=1 but no build output exists; run npm run build first"
      : "npm run build did not produce standalone output");
  }
  if (!existsSync(customServerPath)) {
    missingArtifact(customServerPath, "postbuild scripts/copy-standalone-assets.mjs did not copy the wrapper");
  }
  if (!existsSync(join(standaloneDir, distDir, "static"))) {
    missingArtifact(join(standaloneDir, distDir, "static"), "postbuild static-asset copy missing");
  }
  if (!existsSync(join(standaloneDir, "public"))) {
    missingArtifact(join(standaloneDir, "public"), "postbuild public-asset copy missing");
  }
}

async function waitReady(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (childExit) {
      throw new Error(`[startup-failure] standalone server exited before becoming ready (code=${childExit.code} signal=${childExit.signal})\n--- server logs ---\n${logs}`);
    }
    try {
      if ((await get(port, "/api/health")) === 200) return;
    } catch { /* server is still starting */ }
    await delay(150);
  }
  throw new Error(`[startup-failure] /api/health did not answer 200 within 30s\n--- server logs ---\n${logs}`);
}

// SIGTERM first (graceful on POSIX; Node maps kill() to TerminateProcess on
// Windows), then SIGKILL escalation so the child can never outlive the smoke.
async function stopChild() {
  if (!child || childExit) return;
  child.kill();
  for (let i = 0; i < 50 && !childExit; i++) await delay(100);
  if (!childExit) {
    child.kill("SIGKILL");
    for (let i = 0; i < 20 && !childExit; i++) await delay(100);
  }
}

// Safety net: finally blocks do not run when this process receives a signal,
// so make sure Ctrl+C / kill never leaves an orphaned server behind.
function emergencyStop() {
  if (child && !childExit) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}
process.once("SIGINT", () => { emergencyStop(); process.exit(130); });
process.once("SIGTERM", () => { emergencyStop(); process.exit(143); });

try {
  if (!skipBuild) {
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
      cwd: repo,
      stdio: "inherit",
    });
  }
  assertBuildArtifacts();

  const port = await getFreePort();
  child = spawn(process.execPath, [customServerPath, "--port", String(port)], {
    cwd: standaloneDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      SHOWDAR_ROUTER_DATA_DIR: dataDir,
      DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  child.on("exit", (code, signal) => { childExit = { code, signal }; });
  child.on("error", (error) => {
    childExit = { code: null, signal: null };
    logs += `\nspawn error: ${error.message}`;
  });

  await waitReady(port);
  assert.equal(await get(port, "/login"), 200);
  assert.equal(await get(port, "/api/health"), 200);
  assert.equal(await get(port, "/api/version"), 200);
  assert.doesNotMatch(logs, /client reference manifest for route/i);
  assert.doesNotMatch(logs, /Cannot find module ['"]?\.\/chunks\//i);
  assert.doesNotMatch(logs, /Failed to load static file for page: \/500/i);
  assert.doesNotMatch(logs, /next start does not work with output: standalone/i);
  console.log(`standalone runtime smoke: PASS (${customServerPath}, port ${port})`);
} finally {
  await stopChild();
  rmSync(dataDir, { recursive: true, force: true });
}
