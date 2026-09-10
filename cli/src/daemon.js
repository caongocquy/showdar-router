const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const DEFAULT_PORT = 21298;
const MAX_PORT_ATTEMPTS = 10;
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
    portStateFile: path.join(dataDir, "run", "port-state.json"),
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

function readPortState(state) {
  try {
    const value = JSON.parse(fs.readFileSync(state.portStateFile, "utf8"));
    return Number.isInteger(value.port) ? value : null;
  } catch {
    return null;
  }
}

function clearPortState(state) {
  try { fs.unlinkSync(state.portStateFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function canBindPort(port) {
  try {
    if (execFileSync("lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim()) return false;
  } catch {
    // Fall through to the bind probe when lsof is unavailable.
  }
  const script = "const net=require('node:net');const s=net.createServer();s.once('error',()=>process.exit(1));s.listen(" + port + ",'0.0.0.0',()=>s.close(()=>process.exit(0)));";
  try {
    execFileSync(process.execPath, ["-e", script], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function choosePort({ requestedPort, explicit, portAvailable = canBindPort }) {
  if (explicit) {
    if (!portAvailable(requestedPort)) throw new Error(`Port ${requestedPort} is already in use.`);
    return requestedPort;
  }
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const port = requestedPort + offset;
    if (portAvailable(port)) return port;
  }
  throw new Error(`No available port found from ${requestedPort} after ${MAX_PORT_ATTEMPTS} attempts.`);
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

function start({ appRoot, serverPath, env = process.env, port = null, explicitPort = null, runBuild = true, spawnImpl = spawn, portAvailable = canBindPort }) {
  const state = paths(env);
  ensureDirectories(state);
  if (!fs.existsSync(path.join(appRoot, "node_modules"))) {
    throw new Error("Dependencies are missing. Run npm install first.");
  }
  const envPort = env.SHOWDAR_ROUTER_PORT || env.PORT;
  const requestedPort = Number(port || envPort || DEFAULT_PORT);
  const explicit = explicitPort === null ? Boolean(port || envPort) : explicitPort;
  const existingState = readPortState(state);
  const existing = stalePid(state, appRoot, existingState?.port || requestedPort);
  if (existing) throw new Error(`${APP_NAME} is already running (PID: ${existing})`);
  buildIfRequired({ appRoot, serverPath, runBuild });
  const actualPort = choosePort({ requestedPort, explicit, portAvailable });

  fs.closeSync(fs.openSync(state.logFile, "a"));
  const log = fs.openSync(state.logFile, "a");
  const child = spawnImpl(process.execPath, [serverPath, "--port", String(actualPort)], {
    cwd: appRoot,
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...env,
      NODE_ENV: "production",
      PORT: String(actualPort),
      SHOWDAR_ROUTER_PORT: String(actualPort),
      HOSTNAME: env.HOSTNAME || "0.0.0.0",
      DATA_DIR: state.dataDir,
      SHOWDAR_ROUTER_DATA_DIR: state.dataDir,
    },
  });
  fs.closeSync(log);
  fs.writeFileSync(state.pidFile, `${child.pid}\n`);
  fs.writeFileSync(state.portStateFile, JSON.stringify({ port: actualPort, requestedPort, mode: explicit ? "explicit" : "auto" }) + "\n");
  child.unref();
  return { ...state, pid: child.pid, port: actualPort, requestedPort, explicitPort: explicit, autoFallback: !explicit && actualPort !== requestedPort };
}

function stop({ appRoot, env = process.env }) {
  const state = paths(env);
  const pid = readPid(state.pidFile);
  if (!pid) { clearPid(state.pidFile); clearPortState(state); return false; }
  const port = readPortState(state)?.port || env.SHOWDAR_ROUTER_PORT || env.PORT || DEFAULT_PORT;
  if (processExists(pid) && ownsProcess(pid, appRoot, port)) {
    process.kill(pid, "SIGTERM");
    try {
      if (process.platform !== "win32") execFileSync("sleep", ["0.2"]);
    } catch { /* process may already be gone */ }
  }
  clearPid(state.pidFile);
  clearPortState(state);
  return true;
}

function status({ appRoot, env = process.env }) {
  const state = paths(env);
  const saved = readPortState(state);
  const port = saved?.port || env.SHOWDAR_ROUTER_PORT || env.PORT || DEFAULT_PORT;
  const pid = stalePid(state, appRoot, port);
  if (!pid) { clearPortState(state); return { running: false }; }
  return { running: true, pid, port, requestedPort: saved?.requestedPort || port, explicitPort: saved?.mode === "explicit" };
}

function restart(options) {
  const state = paths(options.env || process.env);
  const saved = readPortState(state);
  const port = options.port ?? (saved?.mode === "explicit" ? saved.requestedPort : (saved ? DEFAULT_PORT : null));
  const explicitPort = options.explicitPort ?? (saved ? saved.mode === "explicit" : null);
  stop(options);
  return start({ ...options, port, explicitPort });
}

function resolveAppRoot(cliRoot) {
  const bundled = path.join(cliRoot, "app");
  return fs.existsSync(bundled) ? bundled : path.resolve(cliRoot, "..");
}

function resolveServerPath(appRoot) {
  const standaloneRoot = fs.existsSync(path.join(appRoot, ".next", "standalone", "server.js"))
    ? path.join(appRoot, ".next", "standalone")
    : appRoot;
  const wrapper = path.join(standaloneRoot, "custom-server.js");
  return fs.existsSync(wrapper) ? wrapper : path.join(standaloneRoot, "server.js");
}

module.exports = { DEFAULT_PORT, getDataDir, paths, ownsProcess, start, stop, restart, status, resolveAppRoot, resolveServerPath, readPortState, canBindPort };
