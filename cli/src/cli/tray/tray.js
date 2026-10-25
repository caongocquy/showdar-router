const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

let trayInstance = null;
let isWinTray = false;

/**
 * Get icon base64 from file — used for systray (mac/linux)
 */
function getIconBase64() {
  const isWin = process.platform === "win32";
  const iconFile = isWin ? "icon.ico" : "icon.png";
  try {
    const iconPath = path.join(__dirname, iconFile);
    if (fs.existsSync(iconPath)) {
      return fs.readFileSync(iconPath).toString("base64");
    }
  } catch (e) {}
  // Fallback: minimal green dot icon (PNG)
  return "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAALEwAACxMBAJqcGAAAAHpJREFUOE9jYBgFgwEwMjIy/Gdg+P8fyP4PxP8ZGBgEcBnGyMjIsICBgSEAhyH/gfgBUNN8XJoZsdkCVL8Ah+b/QPwbqvkBMvk/AwMDAzYX/GdgYAhAN+A/SICRWAMYGfFEJSMjzriEiwDR/xmIa2RkZCSqnZERb3QCAAo3KxzxbKe1AAAAAElFTkSuQmCC";
}

/**
 * Check if system tray is supported on current OS
 * Supported: macOS, Windows, Linux (with GUI)
 */
function isTraySupported(platform = process.platform) {
  if (!["darwin", "win32", "linux"].includes(platform)) {
    return false;
  }
  if (platform === "linux" && !process.env.DISPLAY) {
    return false;
  }
  return true;
}

const TRAY_READY_TIMEOUT_MS = 10000;

function trayFailure(message, cause) {
  return { ok: false, error: cause instanceof Error ? cause : new Error(message) };
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * Initialize system tray with menu.
 * Resolves only after the platform tray confirms readiness, so callers never
 * announce a tray that failed to appear.
 * @param {Object} options - { port, onQuit, onOpenDashboard }
 * @param {Object} [deps] - test seams: { platform, resolveSystrayFn, readyTimeoutMs }
 * @returns {Promise<{ok: boolean, error?: Error}>}
 */
async function initTray(options, deps = {}) {
  const platform = deps.platform || process.platform;
  if (!isTraySupported(platform)) {
    return trayFailure(
      platform === "linux"
        ? "System tray needs a graphical session (DISPLAY is not set)"
        : `System tray is not supported on ${platform}`
    );
  }

  // Windows uses PowerShell NotifyIcon (AV-safe), others use systray
  if (platform === "win32") {
    return initWindowsTray(options);
  }
  return initUnixTray(options, deps);
}

/**
 * Build menu items array shared between platforms
 */
function buildMenuItems(port, running = true) {
  return [
    { title: "Showdar Router", tooltip: "Showdar Router", enabled: false },
    { title: `Server: ${running ? "Running" : "Stopped"}`, tooltip: "Server status", enabled: false },
    { title: `http://localhost:${port}`, tooltip: "Local server URL", enabled: false },
    { title: "Open Dashboard", tooltip: "Open dashboard in browser", enabled: true },
    { title: "Open Logs", tooltip: "Open server logs", enabled: true },
    { title: "Restart Server", tooltip: "Restart Showdar Router", enabled: true },
    { title: "Stop Server", tooltip: "Stop Showdar Router", enabled: true },
    { title: "Quit Tray", tooltip: "Close tray only", enabled: true }
  ];
}

// Menu item indexes
const MENU_INDEX = { TITLE: 0, STATUS: 1, URL: 2, DASHBOARD: 3, LOGS: 4, RESTART: 5, STOP: 6, QUIT: 7 };

/**
 * Handle menu item click (shared logic)
 */
function handleClick(index, options) {
  if (typeof index === "object" && index !== null) {
    const title = index.item?.title;
    const titleIndex = buildMenuItems(options.port, options.running !== false)
      .findIndex((item) => item.title === title);
    index = titleIndex >= 0 ? titleIndex : index.seq_id;
  }
  const { onQuit, onOpenDashboard, onOpenLogs, onRestart, onStop, port } = options;
  if (index === MENU_INDEX.DASHBOARD) {
    if (onOpenDashboard) onOpenDashboard();
    else openBrowser(`http://localhost:${port}/dashboard`);
  } else if (index === MENU_INDEX.LOGS) {
    if (onOpenLogs) onOpenLogs();
  } else if (index === MENU_INDEX.RESTART) {
    if (onRestart) onRestart();
  } else if (index === MENU_INDEX.STOP) {
    return Promise.resolve(onStop && onStop()).finally(() => killTray().finally(() => process.exit(0)));
  } else if (index === MENU_INDEX.QUIT) {
    return Promise.resolve(onQuit && onQuit()).finally(() => killTray().finally(() => process.exit(0)));
  }
}

/**
 * Windows tray via PowerShell NotifyIcon
 */
function initWindowsTray(options) {
  const { port } = options;
  try {
    const { initWinTray } = require("./trayWin");
    const iconPath = path.join(__dirname, "icon.ico");
    const items = buildMenuItems(port, options.running !== false);

    const instance = initWinTray({
      iconPath,
      tooltip: `Showdar Router - Port ${port}`,
      items,
      onClick: (index) => {
        handleClick(index, options);
      }
    });
    if (!instance) return trayFailure("Windows tray initialization returned no instance");

    trayInstance = instance;
    isWinTray = true;
    return { ok: true };
  } catch (err) {
    return trayFailure("Windows tray initialization failed", err);
  }
}

/**
 * macOS/Linux tray via systray binary
 *
 * Prefers `systray2` (active fork of `systray`, ships newer
 * getlantern/systray-portable binaries that work on macOS 14+ and Apple
 * Silicon under Rosetta). Falls back to legacy `systray@1.0.5` if systray2
 * is not available, though that binary's Mach-O headers are rejected by
 * modern dyld and the icon will not appear.
 */
function resolveSystray() {
  let runtimeDir = null;
  try {
    const { getRuntimeNodeModules } = require("../../../hooks/sqliteRuntime");
    runtimeDir = getRuntimeNodeModules();
  } catch (e) {}

  // 1) systray2 in runtime dir (where ensureTrayRuntime installs it)
  if (runtimeDir) {
    try { return { mod: require(path.join(runtimeDir, "systray2")).default, isV2: true }; } catch (e) {}
  }
  // 2) systray2 resolvable from the package's own node_modules / NODE_PATH
  try { return { mod: require("systray2").default, isV2: true }; } catch (e) {}
  // 3) Legacy systray fallback (unlikely to render on modern macOS)
  try { return { mod: require("systray").default, isV2: false }; } catch (e) {}
  if (runtimeDir) {
    try { return { mod: require(path.join(runtimeDir, "systray")).default, isV2: false }; } catch (e) {}
  }
  return null;
}

function chmodTrayBin(pkgName) {
  // systray2's npm tarball occasionally lands without +x on the bundled Go
  // binary (observed on macOS). spawn() then fails with EACCES. Best-effort
  // chmod on every init avoids a hard-to-diagnose silent tray failure.
  try {
    const { getRuntimeNodeModules } = require("../../../hooks/sqliteRuntime");
    const binName = process.platform === "darwin" ? "tray_darwin_release" : "tray_linux_release";
    const candidates = [
      path.join(getRuntimeNodeModules(), pkgName, "traybin", binName),
      path.join(__dirname, "..", "..", "..", "node_modules", pkgName, "traybin", binName)
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    }
  } catch (e) {}
}

async function initUnixTray(options, deps = {}) {
  const { port } = options;
  const resolveFn = deps.resolveSystrayFn || resolveSystray;
  const timeoutMs = deps.readyTimeoutMs || TRAY_READY_TIMEOUT_MS;
  try {
    const resolved = resolveFn();
    if (!resolved) {
      return trayFailure(
        "System tray binary is not installed (systray2 missing from the runtime dir)"
      );
    }
    const { mod: SysTray, isV2 } = resolved;

    chmodTrayBin(isV2 ? "systray2" : "systray");

    const items = buildMenuItems(port, options.running !== false);

    const menu = {
      icon: getIconBase64(),
      // The bundled icon.png is a full-color RGBA logo. Don't mark it as a
      // template icon: macOS would then render it as a solid white square
      // because template mode only uses the alpha channel.
      isTemplateIcon: false,
      title: "",
      tooltip: `Showdar Router - Port ${port}`,
      items
    };

    const instance = new SysTray({ menu, debug: false, copyDir: true });
    trayInstance = instance;
    isWinTray = false;

    instance.onClick((action) => {
      handleClick(action, options);
    });

    // Wait for the real readiness signal. Without this the caller could print
    // "running in system tray" while the Go binary crashed (bad binary, EACCES,
    // no GUI session) and no icon ever appeared.
    const readyPromise = isV2
      ? Promise.resolve(instance.ready())
      : new Promise((resolve, reject) => {
          instance.onReady(resolve);
          instance.onError(reject);
        });
    try {
      await withTimeout(readyPromise, timeoutMs, `Tray not ready after ${timeoutMs}ms`);
    } catch (err) {
      // Never leave a half-started tray process behind.
      try { await killTray(); } catch (e) {}
      return trayFailure("System tray failed to start", err);
    }

    return { ok: true };
  } catch (err) {
    try { await killTray(); } catch (e) {}
    return trayFailure("System tray initialization failed", err);
  }
}

/**
 * Kill tray, wait Go binary fully exit (returns Promise).
 * Critical for hide-to-tray: macOS must release NSStatusItem before bgProcess
 * spawns a new tray, otherwise the new icon silently fails to register.
 */
function killTray() {
  const instance = trayInstance;
  const wasWin = isWinTray;
  trayInstance = null;
  if (!instance) return Promise.resolve();

  if (wasWin) {
    try { instance.kill(); } catch (e) {}
    return Promise.resolve();
  }

  // Unix: get the Go tray child process handle.
  let proc = null;
  try {
    proc = instance._process || (typeof instance.process === "function" ? instance.process() : null);
  } catch (e) {}

  // Graceful shutdown: send {type:"exit"} via IPC so the Go binary can call
  // systray.Quit() and release NSStatusItem. SIGKILL leaves a ghost icon on
  // the macOS menubar until logout, causing duplicate icons after re-spawn.
  const gracefulQuit = () => { try { instance.kill(true); } catch (e) {} };
  const closeIpc = () => { try { instance.kill(false); } catch (e) {} };

  if (!proc || !proc.pid) {
    gracefulQuit();
    closeIpc();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; closeIpc(); resolve(); };

    proc.once("exit", finish);
    gracefulQuit();

    // Escalate: SIGTERM after 800ms, SIGKILL after 1600ms if still alive.
    setTimeout(() => { try { process.kill(proc.pid, 0); proc.kill("SIGTERM"); } catch (e) {} }, 800);
    setTimeout(() => { try { process.kill(proc.pid, 0); proc.kill("SIGKILL"); } catch (e) {} }, 1600);

    // Fallback poll in case "exit" never fires (detached child, pipe closed)
    const deadline = Date.now() + 3000;
    const poll = setInterval(() => {
      try { process.kill(proc.pid, 0); } catch { clearInterval(poll); finish(); return; }
      if (Date.now() > deadline) { clearInterval(poll); finish(); }
    }, 50);
  });
}

/**
 * Open browser
 */
function openBrowser(url) {
  const platform = process.platform;
  let cmd;

  if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd);
}

module.exports = {
  initTray,
  killTray,
  buildMenuItems,
  handleClick,
  MENU_INDEX
};
