const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const DEFAULT_PORT = 20129;
const APP_NAME = "Showdar Router";

function getDataDir(env = process.env) {
  return env.SHOWDAR_ROUTER_DATA_DIR || env.DATA_DIR || path.join(os.homedir(), ".showdar-router");
}

function paths(env = process.env) {
  const dataDir = getDataDir(env);
  return {
    dataDir,
    runDir: path.join(dataDir, "run"),
    logDir: path.join(dataDir, "logs"),
    pidFile: path.join(dataDir, "run", "showdar-router.pid"),
    logFile: path.join(dataDir, "logs", "showdar-router.log"),
  };
}

function readPid(pidFile) {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processCommand(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function ownsProcess(pid, appRoot, port = DEFAULT_PORT) {
  const command = processCommand(pid);
  if (command.includes("custom-server.js") && command.includes(path.resolve(appRoot))) return true;
  if (!command.startsWith("next-server")) return false;
  try {
    const listeners = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP:" + port, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim();
    return listeners.split(/\s+/).includes(String(pid));
  } catch {
    return false;
  }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function clearPid(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function ensureDirectories(state) {
  fs.mkdirSync(state.runDir, { recursive: true });
  fs.mkdirSync(state.logDir, { recursive: true });
}

function stalePid(state, appRoot, port = DEFAULT_PORT) {
  const pid = readPid(state.pidFile);
  if (!pid) {
    if (fs.existsSync(state.pidFile)) clearPid(state.pidFile);
    return null;
  }
  if (!processExists(pid) || !ownsProcess(pid, appRoot, port)) {
    clearPid(state.pidFile);
    return null;
  }
  return pid;
}

function buildIfRequired({ appRoot, serverPath, runBuild = true }) {
  const buildMarker = path.join(appRoot, ".next", "BUILD_ID");
  const packagedBuild = fs.existsSync(path.join(appRoot, "server.js"));
  if (fs.existsSync(serverPath) && (fs.existsSync(buildMarker) || packagedBuild)) return;
  if (!runBuild) throw new Error("Production build is missing. Run npm run build first.");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["run", "build"], { cwd: appRoot, stdio: "inherit" });
  if (!fs.existsSync(serverPath) || (!fs.existsSync(buildMarker) && !packagedBuild)) {
    throw new Error("Production build completed without a standalone server entrypoint.");
  }
}

function start({ appRoot, serverPath, env = process.env, runBuild = true, spawnImpl = spawn }) {
  const state = paths(env);
  ensureDirectories(state);
  if (!fs.existsSync(path.join(appRoot, "node_modules"))) {
    throw new Error("Dependencies are missing. Run npm install first.");
  }
  const port = env.SHOWDAR_ROUTER_PORT || env.PORT || DEFAULT_PORT;
  const existing = stalePid(state, appRoot, port);
  if (existing) throw new Error(`${APP_NAME} is already running (PID: ${existing})`);
  buildIfRequired({ appRoot, serverPath, runBuild });

  fs.closeSync(fs.openSync(state.logFile, "a"));
  const log = fs.openSync(state.logFile, "a");
  const child = spawnImpl(process.execPath, [serverPath, "--port", String(port)], {
    cwd: appRoot,
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...env,
      NODE_ENV: "production",
      PORT: String(port),
      SHOWDAR_ROUTER_PORT: String(port),
      HOSTNAME: env.HOSTNAME || "0.0.0.0",
      DATA_DIR: state.dataDir,
      SHOWDAR_ROUTER_DATA_DIR: state.dataDir,
    },
  });
  fs.closeSync(log);
  fs.writeFileSync(state.pidFile, `${child.pid}\n`);
  child.unref();
  return { ...state, pid: child.pid, port };
}

function stop({ appRoot, env = process.env }) {
  const state = paths(env);
  const pid = readPid(state.pidFile);
  if (!pid) { clearPid(state.pidFile); return false; }
  const port = env.SHOWDAR_ROUTER_PORT || env.PORT || DEFAULT_PORT;
  if (processExists(pid) && ownsProcess(pid, appRoot, port)) {
    process.kill(pid, "SIGTERM");
    try {
      if (process.platform !== "win32") execFileSync("sleep", ["0.2"]);
    } catch { /* process may already be gone */ }
  }
  clearPid(state.pidFile);
  return true;
}

function status({ appRoot, env = process.env }) {
  const state = paths(env);
  const port = env.SHOWDAR_ROUTER_PORT || env.PORT || DEFAULT_PORT;
  const pid = stalePid(state, appRoot, port);
  return pid ? { running: true, pid, port: env.SHOWDAR_ROUTER_PORT || env.PORT || DEFAULT_PORT } : { running: false };
}

function resolveAppRoot(cliRoot) {
  const bundled = path.join(cliRoot, "app");
  return fs.existsSync(bundled) ? bundled : path.resolve(cliRoot, "..");
}

function resolveServerPath(appRoot) {
  const standaloneRoot = fs.existsSync(path.join(appRoot, ".next", "standalone", "server.js"))
    ? path.join(appRoot, ".next", "standalone")
    : appRoot;
  return path.join(standaloneRoot, "server.js");
}

module.exports = { DEFAULT_PORT, getDataDir, paths, ownsProcess, start, stop, status, resolveAppRoot, resolveServerPath };
