import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Behavioral tests - Fixed implementation matches upstream", () => {
  let originalEnv;
  let tempDir;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-router-behavior-test-"));
    process.env.SHOWDAR_ROUTER_DATA_DIR = tempDir;
  });

  afterEach(() => {
    process.env = originalEnv;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });

  // Test 1: Normal startup should use upstream supervisor pattern (NOT daemon.start)
  it("cli.js should NOT have early daemon/launcher routing that intercepts startup", () => {
    const cliPath = "./cli/cli.js";
    const cliContent = fs.readFileSync(cliPath, "utf8");
    
    // FIXED: Should NOT have daemon/launcher imports and early returns
    const hasLauncherRequire = cliContent.includes("const launcher = require");
    const hasDaemonRequire = cliContent.includes("const daemon = require");
    const hasEarlyInteractiveReturn = cliContent.includes('requestedCommand === "interactive"') && 
                                    cliContent.includes("runInteractiveLauncher()");
    const hasEarlyTrayReturn = cliContent.includes('requestedCommand === "tray"') && 
                               cliContent.includes("launcher.runTray");
    const hasDaemonCommands = cliContent.includes("daemonCommands.has(requestedCommand)");
    
    // After fix, all these should be false
    expect(hasLauncherRequire).toBe(false);
    expect(hasDaemonRequire).toBe(false);
    expect(hasEarlyInteractiveReturn).toBe(false);
    expect(hasEarlyTrayReturn).toBe(false);
    expect(hasDaemonCommands).toBe(false);
  });

  // Test 2: Tray mode should spawn detached CLI supervisor
  it("Hide to Tray should spawn: node cli.js --tray --skip-update -p <port>", () => {
    const cliPath = "./cli/cli.js";
    const cliContent = fs.readFileSync(cliPath, "utf8");
    
    // FIXED: Should spawn detached cli.js --tray process
    const spawnsTrayCli = cliContent.includes("spawn(process.execPath") && 
                         cliContent.includes("__filename") && 
                         cliContent.includes("--tray") && 
                         cliContent.includes("--skip-update") &&
                         cliContent.includes("bgProcess.unref()");
    
    // Should NOT use launcher.runTray
    const usesLauncherRunTray = cliContent.includes("launcher.runTray");
    
    expect(spawnsTrayCli).toBe(true);
    expect(usesLauncherRunTray).toBe(false);
  });

  // Test 3: Server restart behavior (should be reachable now)
  it("should have tryRestart function for supervisor pattern", () => {
    const cliPath = "./cli/cli.js";
    const cliContent = fs.readFileSync(cliPath, "utf8");
    
    const hasTryRestart = cliContent.includes("function tryRestart");
    const hasMaxRestarts = cliContent.includes("const MAX_RESTARTS");
    const hasRestartResetMs = cliContent.includes("const RESTART_RESET_MS");
    const hasServerCloseHandler = cliContent.includes("server.on(\"close\"");
    const hasServerErrorHandler = cliContent.includes("server.on(\"error\"");
    const hasAttachServerEvents = cliContent.includes("function attachServerEvents");
    
    // These should all exist and be reachable
    expect(hasTryRestart).toBe(true);
    expect(hasMaxRestarts).toBe(true);
    expect(hasRestartResetMs).toBe(true);
    expect(hasServerCloseHandler).toBe(true);
    expect(hasServerErrorHandler).toBe(true);
    expect(hasAttachServerEvents).toBe(true);
  });

  // Test 4: Intentional shutdown should not restart
  it("should have isShuttingDown flag to prevent restart on intentional exit", () => {
    const cliPath = "./cli/cli.js";
    const cliContent = fs.readFileSync(cliPath, "utf8");
    
    const hasIsShuttingDown = cliContent.includes("let isShuttingDown = false");
    const hasSigintHandler = cliContent.includes("process.on(\"SIGINT\"");
    const hasSigtermHandler = cliContent.includes("process.on(\"SIGTERM\"");
    const hasSighupHandler = cliContent.includes("process.on(\"SIGHUP\"");
    const hasCleanup = cliContent.includes("function cleanup()");
    
    expect(hasIsShuttingDown).toBe(true);
    expect(hasSigintHandler).toBe(true);
    expect(hasSigtermHandler).toBe(true);
    expect(hasSighupHandler).toBe(true);
    expect(hasCleanup).toBe(true);
  });

  // Test 5: No duplicate port fallback instances
  it("should kill previous Showdar-owned processes before starting new server", () => {
    const cliPath = "./cli/cli.js";
    const cliContent = fs.readFileSync(cliPath, "utf8");
    
    const hasKillAllAppProcesses = cliContent.includes("function killAllAppProcesses");
    const hasKillProcessOnPort = cliContent.includes("function killProcessOnPort");
    const callsKillBeforeStart = cliContent.includes("killAllAppProcesses(port)") && 
                                cliContent.includes("killProcessOnPort(port)") &&
                                cliContent.includes("startServer(updatePromise)");
    
    expect(hasKillAllAppProcesses).toBe(true);
    expect(hasKillProcessOnPort).toBe(true);
    expect(callsKillBeforeStart).toBe(true);
  });

  // Test 6: Tray-only mode (--tray flag) should enter supervisor pattern
  it("trayMode should run supervisor with tray icon, not launcher", () => {
    const cliPath = "./cli/cli.js";
    const cliContent = fs.readFileSync(cliPath, "utf8");
    
    // Should have trayMode branch that initializes tray and returns (supervisor stays alive)
    const hasTrayModeBranch = cliContent.includes("if (trayMode)") && 
                              cliContent.includes("process.removeAllListeners(\"SIGHUP\")") &&
                              cliContent.includes("initTrayIcon()") &&
                              cliContent.includes("return;"); // Returns, keeping supervisor alive
    
    // Should NOT call launcher.runTray
    const usesLauncher = cliContent.includes("launcher.runTray");
    
    expect(hasTrayModeBranch).toBe(true);
    expect(usesLauncher).toBe(false);
  });
});

describe("Showdar-specific differences preserved", () => {
  it("Showdar Router default port is 21298, not 20128", () => {
    const cliPath = "./cli/cli.js";
    const cliContent = fs.readFileSync(cliPath, "utf8");
    expect(cliContent).toContain("const DEFAULT_PORT = 21298;");
    expect(cliContent).not.toContain("const DEFAULT_PORT = 20128;");
  });

  it("Showdar Router uses .showdar-router data directory, not .9router", () => {
    const cliPath = "./cli/cli.js";
    const cliContent = fs.readFileSync(cliPath, "utf8");
    expect(cliContent).toContain(".showdar-router");
    expect(cliContent).not.toContain(".9router");
  });

  it("Showdar Router has xAI video subcommand", () => {
    const cliPath = "./cli/cli.js";
    const cliContent = fs.readFileSync(cliPath, "utf8");
    expect(cliContent).toContain("xai");
    expect(cliContent).toContain("video");
    expect(cliContent).toContain("xaiVideo");
  });

  it("Showdar Router has SQLite runtime self-heal", () => {
    const cliPath = "./cli/cli.js";
    const cliContent = fs.readFileSync(cliPath, "utf8");
    expect(cliContent).toContain("ensureSqliteRuntime");
    expect(cliContent).toContain("buildEnvWithRuntime");
  });

  it("Showdar Router has tray runtime self-heal", () => {
    const cliPath = "./cli/cli.js";
    const cliContent = fs.readFileSync(cliPath, "utf8");
    expect(cliContent).toContain("ensureTrayRuntime");
  });

  it("Showdar Router uses showdar-router package name for branding", () => {
    const cliPath = "./cli/cli.js";
    const cliContent = fs.readFileSync(cliPath, "utf8");
    expect(cliContent).toContain('const APP_NAME = pkg.name;');
    expect(cliContent).toContain("showdar-router");
    expect(cliContent).not.toContain("9router");
  });

  it("Showdar Router killAllAppProcesses targets showdar-router processes", () => {
    const cliPath = "./cli/cli.js";
    const cliContent = fs.readFileSync(cliPath, "utf8");
    expect(cliContent).toContain('const PROCESS_IDENTIFIERS = [');
    expect(cliContent).toContain("showdar-router");
    expect(cliContent).not.toContain("9router");
  });
});