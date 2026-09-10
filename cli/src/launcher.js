const { spawn } = require("node:child_process");
const path = require("node:path");

const DEFAULT_PORT = 21298;
const interfaceItems = [
  { label: "Web UI (Open in Browser)" },
  { label: "Terminal UI (Interactive CLI)" },
  { label: "Hide to Tray (Background)" },
  { label: "Exit" },
];

function getLaunchMode(args, isTTY) {
  if (!args.length && isTTY) return "interactive";
  if (args[0] === "--port" || args[0] === "-p") return "start";
  return args[0] || "start";
}

function ensureDaemon({ daemon, appRoot, env, port = null, explicitPort = null }) {
  const current = daemon.status({ appRoot, env });
  if (current.running) return current;
  return daemon.start({
    appRoot,
    serverPath: daemon.resolveServerPath ? daemon.resolveServerPath(appRoot) : undefined,
    env,
    port,
    explicitPort,
  });
}

function open(url) {
  if (process.platform === "darwin") return spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  if (process.platform === "win32") return spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function dashboardUrl(port) {
  return `http://localhost:${port}/dashboard`;
}

function getTrayChildArgs(args) {
  return ["--tray", ...args.slice(1)];
}

function startTrayProcess({ cliPath, port }) {
  const child = spawn(process.execPath, [cliPath, "tray"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, SHOWDAR_ROUTER_PORT: String(port) },
  });
  child.unref();
  return child.pid;
}

function runTray({ daemon, tray, appRoot, env = process.env, port = null, explicitPort = null, cliPath = path.resolve(__dirname, "..", "cli.js") }) {
  const current = ensureDaemon({ daemon, appRoot, env, port, explicitPort });
  const activePort = current.port || Number(env.SHOWDAR_ROUTER_PORT || env.PORT || daemon.DEFAULT_PORT || DEFAULT_PORT);
  let instance;
  const refresh = () => {
    if (!instance?.sendAction) return;
    const state = daemon.status({ appRoot, env });
    const items = require("./cli/tray/tray").buildMenuItems(state.port || activePort, state.running);
    return Promise.all([
      instance.sendAction({ type: "update-item", seq_id: 1, item: items[1] }),
      instance.sendAction({ type: "update-item", seq_id: 2, item: items[2] }),
    ]);
  };
  const options = {
    port: activePort,
    running: true,
    onOpenDashboard: () => open(dashboardUrl(activePort)),
    onOpenLogs: () => open(daemon.paths(env).logFile),
    onRestart: () => {
      const result = daemon.restart
        ? daemon.restart({ appRoot, serverPath: daemon.resolveServerPath(appRoot), env })
        : (daemon.stop({ appRoot, env }), ensureDaemon({ daemon, appRoot, env }));
      return Promise.resolve(result).then(refresh);
    },
    onStop: () => {
      daemon.stop({ appRoot, env });
      return refresh();
    },
    onQuit: () => daemon.stop({ appRoot, env }),
  };
  instance = tray.initTray(options);
  if (!instance) throw new Error("System tray is unavailable on this platform.");
  return { ...current, tray: instance };
}

async function runInteractive({ daemon, tray, appRoot, env = process.env, cliPath, selectMenu }) {
  const { selectMenu: defaultSelectMenu } = require("./cli/utils/input");
  const select = selectMenu || defaultSelectMenu;
  const current = ensureDaemon({ daemon, appRoot, env });
  const port = current.port || Number(env.SHOWDAR_ROUTER_PORT || env.PORT || daemon.DEFAULT_PORT || DEFAULT_PORT);
  const choice = await select(
    `Choose Interface (v${require(path.resolve(__dirname, "..", "package.json")).version})`,
    interfaceItems,
    0,
    `🚀 Server: http://localhost:${port}`
  );
  if (choice === 0) open(`http://localhost:${port}/dashboard`);
  if (choice === 1) {
    const { startTerminalUI } = require("./cli/terminalUI");
    await startTerminalUI(port);
  }
  if (choice === 2) startTrayProcess({ cliPath: cliPath || path.resolve(__dirname, "..", "cli.js"), port });
}

module.exports = { DEFAULT_PORT, interfaceItems, getLaunchMode, ensureDaemon, runInteractive, runTray, dashboardUrl, getTrayChildArgs };
