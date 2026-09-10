import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const daemon = require("../../cli/src/daemon.js");
const tempDirs = [];

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-router-daemon-"));
  tempDirs.push(dir);
  return { SHOWDAR_ROUTER_DATA_DIR: dir };
}

afterEach(() => tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("Showdar Router daemon", () => {
  it("uses the new default data directory and port", () => {
    expect(daemon.DEFAULT_PORT).toBe(20129);
    expect(daemon.getDataDir({})).toBe(path.join(os.homedir(), ".showdar-router"));
  });

  it("creates PID and log directories on start", () => {
    const env = tempEnv();
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-router-app-"));
    tempDirs.push(appRoot);
    const standaloneRoot = path.join(appRoot, ".next", "standalone");
    const serverPath = path.join(standaloneRoot, "server.js");
    fs.mkdirSync(standaloneRoot, { recursive: true });
    fs.writeFileSync(path.join(standaloneRoot, "server.js"), "");
    fs.mkdirSync(path.join(appRoot, "node_modules"));
    fs.writeFileSync(path.join(appRoot, ".next", "BUILD_ID"), "test");
    expect(daemon.resolveServerPath(appRoot)).toBe(serverPath);
    const result = daemon.start({ appRoot, serverPath, env, runBuild: false, spawnImpl: () => ({ pid: 4242, unref() {} }) });
    expect(result.pid).toBe(4242);
    expect(fs.existsSync(result.pidFile)).toBe(true);
    expect(fs.existsSync(result.logFile)).toBe(true);
  });

  it("starts the generated standalone server instead of custom-server, next start, or next dev", () => {
    const env = tempEnv();
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-router-app-"));
    tempDirs.push(appRoot);
    const standaloneRoot = path.join(appRoot, ".next", "standalone");
    const serverPath = path.join(standaloneRoot, "server.js");
    fs.mkdirSync(standaloneRoot, { recursive: true });
    fs.writeFileSync(path.join(standaloneRoot, "server.js"), "");
    fs.mkdirSync(path.join(appRoot, "node_modules"));
    fs.writeFileSync(path.join(appRoot, ".next", "BUILD_ID"), "test");

    let spawnArgs;
    daemon.start({
      appRoot,
      serverPath,
      env,
      runBuild: false,
      spawnImpl: (...args) => {
        spawnArgs = args;
        return { pid: 4243, unref() {} };
      },
    });

    expect(spawnArgs[0]).toBe(process.execPath);
    expect(spawnArgs[1][0]).toBe(serverPath);
    expect(spawnArgs[1][0]).not.toContain("custom-server.js");
    expect(spawnArgs[1]).not.toContain("start");
    expect(spawnArgs[1]).not.toContain("dev");
    expect(spawnArgs[2].env.PORT).toBe("20129");
    expect(spawnArgs[2].env.SHOWDAR_ROUTER_DATA_DIR).toBe(env.SHOWDAR_ROUTER_DATA_DIR);
    expect(spawnArgs[2].env.HOSTNAME).toBe("0.0.0.0");
  });

  it("recovers a stale PID file without touching an unrelated process", () => {
    const env = tempEnv();
    const state = daemon.paths(env);
    fs.mkdirSync(state.runDir, { recursive: true });
    fs.writeFileSync(state.pidFile, `${process.pid}\n`);
    expect(daemon.stop({ appRoot: os.tmpdir(), env })).toBe(true);
    expect(fs.existsSync(state.pidFile)).toBe(false);
  });

  it("rejects duplicate starts when the PID belongs to Showdar Router", () => {
    const env = tempEnv();
    const state = daemon.paths(env);
    fs.mkdirSync(state.runDir, { recursive: true });
    fs.writeFileSync(state.pidFile, `${process.pid}\n`);
    expect(daemon.ownsProcess(process.pid, process.cwd())).toBe(false);
  });
});
