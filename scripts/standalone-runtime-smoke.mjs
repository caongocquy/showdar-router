import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const daemon = require("../cli/src/daemon.js");
const repo = process.cwd();
const port = 20130;
const dataDir = mkdtempSync(join(tmpdir(), "showdar-router-runtime-"));
let child;

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: pathname }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitReady() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await get("/api/health")) === 200) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("standalone server did not become ready");
}

try {
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
    cwd: repo,
    stdio: "inherit",
  });
  const serverPath = daemon.resolveServerPath(repo);
  assert.equal(serverPath, join(repo, ".next", "standalone", "custom-server.js"));
  assert.ok(existsSync(join(repo, ".next", "standalone", "server.js")));
  assert.ok(existsSync(join(repo, ".next", "standalone", ".next", "static")));
  assert.ok(existsSync(join(repo, ".next", "standalone", "public")));
  child = spawn(process.execPath, [serverPath, "--port", String(port)], {
    cwd: repo,
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
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  await waitReady();
  assert.equal(await get("/login"), 200);
  assert.equal(await get("/api/health"), 200);
  assert.equal(await get("/api/version"), 200);
  assert.doesNotMatch(logs, /client reference manifest for route/i);
  assert.doesNotMatch(logs, /Cannot find module ['"]?\.\/chunks\//i);
  assert.doesNotMatch(logs, /Failed to load static file for page: \/500/i);
  assert.doesNotMatch(logs, /next start does not work with output: standalone/i);
  console.log("standalone runtime smoke: PASS");
} finally {
  if (child && !child.killed) child.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
}
