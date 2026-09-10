import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(daemon.DEFAULT_PORT).toBe(21298);
    expect(daemon.getDataDir({})).toBe(path.join(os.homedir(), ".showdar-router"));
  });

  it("creates PID and log directories on start", () => {
    const env = tempEnv();
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-router-app-"));
    tempDirs.push(appRoot);
    const standaloneRoot = path.join(appRoot, ".next", "standalone");
    const serverPath = path.join(standaloneRoot, "custom-server.js");
    fs.mkdirSync(standaloneRoot, { recursive: true });
    fs.writeFileSync(path.join(standaloneRoot, "server.js"), "");
    fs.writeFileSync(serverPath, "");
    fs.mkdirSync(path.join(appRoot, "node_modules"));
    fs.writeFileSync(path.join(appRoot, ".next", "BUILD_ID"), "test");
    expect(daemon.resolveServerPath(appRoot)).toBe(serverPath);
    const result = daemon.start({ appRoot, serverPath, env, runBuild: false, portAvailable: () => true, spawnImpl: () => ({ pid: 4242, unref() {} }) });
    expect(result.pid).toBe(4242);
    expect(result.port).toBe(21298);
    expect(fs.existsSync(result.pidFile)).toBe(true);
    expect(fs.existsSync(result.logFile)).toBe(true);
  });

  it("starts the trusted standalone wrapper instead of next start or next dev", () => {
    const env = tempEnv();
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-router-app-"));
    tempDirs.push(appRoot);
    const standaloneRoot = path.join(appRoot, ".next", "standalone");
    const serverPath = path.join(standaloneRoot, "custom-server.js");
    fs.mkdirSync(standaloneRoot, { recursive: true });
    fs.writeFileSync(path.join(standaloneRoot, "server.js"), "");
    fs.writeFileSync(serverPath, "");
    fs.mkdirSync(path.join(appRoot, "node_modules"));
    fs.writeFileSync(path.join(appRoot, ".next", "BUILD_ID"), "test");

    let spawnArgs;
    daemon.start({
      appRoot,
      serverPath,
      env,
      runBuild: false,
      portAvailable: () => true,
      spawnImpl: (...args) => {
        spawnArgs = args;
        return { pid: 4243, unref() {} };
      },
    });

    expect(spawnArgs[0]).toBe(process.execPath);
    expect(spawnArgs[1][0]).toBe(serverPath);
    expect(spawnArgs[1][0]).toContain("custom-server.js");
    expect(spawnArgs[1]).not.toContain("start");
    expect(spawnArgs[1]).not.toContain("dev");
    expect(spawnArgs[2].env.PORT).toBe("21298");
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

  it("falls back across occupied default ports", () => {
    const env = tempEnv();
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-router-app-"));
    tempDirs.push(appRoot);
    const standaloneRoot = path.join(appRoot, ".next", "standalone");
    const serverPath = path.join(standaloneRoot, "server.js");
    fs.mkdirSync(standaloneRoot, { recursive: true });
    fs.writeFileSync(serverPath, "");
    fs.mkdirSync(path.join(appRoot, "node_modules"));
    fs.writeFileSync(path.join(appRoot, ".next", "BUILD_ID"), "test");
    const occupied = new Set([21298, 21299]);
    const result = daemon.start({
      appRoot, serverPath, env, runBuild: false,
      portAvailable: (port) => !occupied.has(port),
      spawnImpl: () => ({ pid: 4244, unref() {} }),
    });
    expect(result.port).toBe(21300);
    expect(JSON.parse(fs.readFileSync(result.portStateFile, "utf8"))).toMatchObject({ port: 21300, mode: "auto" });
  });

  it("fails an occupied explicit port without trying the next port", () => {
    const env = tempEnv();
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-router-app-"));
    tempDirs.push(appRoot);
    const serverPath = path.join(appRoot, "server.js");
    fs.writeFileSync(serverPath, "");
    fs.mkdirSync(path.join(appRoot, "node_modules"));
    fs.mkdirSync(path.join(appRoot, ".next"));
    fs.writeFileSync(path.join(appRoot, ".next", "BUILD_ID"), "test");
    const checked = [];
    const spawnImpl = vi.fn();
    expect(() => daemon.start({
      appRoot, serverPath, env, port: 30000, explicitPort: true, runBuild: false,
      portAvailable: (port) => { checked.push(port); return false; }, spawnImpl,
    })).toThrow("Port 30000 is already in use.");
    expect(checked).toEqual([30000]);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("restarts automatic mode from the canonical default first", () => {
    const env = tempEnv();
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-router-app-"));
    tempDirs.push(appRoot);
    const standaloneRoot = path.join(appRoot, ".next", "standalone");
    const serverPath = path.join(standaloneRoot, "server.js");
    fs.mkdirSync(standaloneRoot, { recursive: true });
    fs.writeFileSync(serverPath, "");
    fs.mkdirSync(path.join(appRoot, "node_modules"));
    fs.writeFileSync(path.join(appRoot, ".next", "BUILD_ID"), "test");
    const available = [false, true, true];
    const ports = [];
    const spawnImpl = () => ({ pid: 4245 + ports.length, unref() {} });
    const portAvailable = (port) => { ports.push(port); return available.shift(); };
    daemon.start({ appRoot, serverPath, env, runBuild: false, portAvailable, spawnImpl });
    const result = daemon.restart({ appRoot, serverPath, env, runBuild: false, portAvailable, spawnImpl });
    expect(result.port).toBe(21298);
  });

  it("restarts explicit mode on the same port", () => {
    const env = tempEnv();
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-router-app-"));
    tempDirs.push(appRoot);
    const serverPath = path.join(appRoot, "server.js");
    fs.writeFileSync(serverPath, "");
    fs.mkdirSync(path.join(appRoot, "node_modules"));
    fs.mkdirSync(path.join(appRoot, ".next"));
    fs.writeFileSync(path.join(appRoot, ".next", "BUILD_ID"), "test");
    const ports = [];
    const spawnImpl = () => ({ pid: 4246 + ports.length, unref() {} });
    const result = daemon.start({ appRoot, serverPath, env, port: 30000, explicitPort: true, runBuild: false, portAvailable: (port) => { ports.push(port); return true; }, spawnImpl });
    daemon.restart({ appRoot, serverPath, env, runBuild: false, portAvailable: (port) => { ports.push(port); return true; }, spawnImpl });
    expect(result.port).toBe(30000);
    expect(ports.at(-1)).toBe(30000);
  });

  it("does not report a stale active port as running", () => {
    const env = tempEnv();
    const state = daemon.paths(env);
    fs.mkdirSync(state.runDir, { recursive: true });
    fs.writeFileSync(state.pidFile, `${process.pid}\n`);
    fs.writeFileSync(state.portStateFile, JSON.stringify({ port: 21299, mode: "auto" }));
    expect(daemon.status({ appRoot: os.tmpdir(), env })).toEqual({ running: false });
    expect(fs.existsSync(state.portStateFile)).toBe(false);
  });
});
