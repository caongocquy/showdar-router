import { describe, expect, it, vi } from "vitest";
import { getLaunchMode, interfaceItems, ensureDaemon, runTray } from "../../cli/src/launcher.js";
import { buildMenuItems, handleClick, MENU_INDEX } from "../../cli/src/cli/tray/tray.js";

describe("Showdar Router launcher", () => {
  it("uses the interactive selector only for a TTY with no arguments", () => {
    expect(getLaunchMode([], true)).toBe("interactive");
    expect(getLaunchMode([], false)).toBe("start");
    expect(getLaunchMode(["start"], true)).toBe("start");
    expect(getLaunchMode(["tray"], true)).toBe("tray");
  });

  it("keeps the interface selector branded and ordered", () => {
    expect(interfaceItems.map((item) => item.label)).toEqual([
      "Web UI (Open in Browser)",
      "Terminal UI (Interactive CLI)",
      "Hide to Tray (Background)",
      "Exit",
    ]);
  });

  it("starts the daemon once before attaching the tray", () => {
    const daemon = {
      DEFAULT_PORT: 20129,
      status: vi.fn(() => ({ running: false })),
      start: vi.fn(() => ({ pid: 42, port: 20129 })),
    };
    const tray = { initTray: vi.fn(() => ({ tray: true })) };
    const result = runTray({ daemon, tray, env: {}, appRoot: "/repo" });
    expect(result.tray).toEqual({ tray: true });
    expect(daemon.start).toHaveBeenCalledOnce();
    expect(tray.initTray).toHaveBeenCalledWith(expect.objectContaining({ port: 20129, running: true }));
  });

  it("does not start a duplicate daemon when attaching to a running server", () => {
    const daemon = { DEFAULT_PORT: 20129, status: vi.fn(() => ({ running: true, pid: 7 })), start: vi.fn() };
    const tray = { initTray: vi.fn(() => ({ tray: true })) };
    runTray({ daemon, tray, env: {}, appRoot: "/repo" });
    expect(daemon.start).not.toHaveBeenCalled();
  });

  it("keeps tray quit separate from daemon stop and restart", () => {
    let options;
    const daemon = {
      DEFAULT_PORT: 20129,
      paths: vi.fn(() => ({ logFile: "/tmp/showdar-router.log" })),
      status: vi.fn()
        .mockReturnValueOnce({ running: true, pid: 7 })
        .mockReturnValueOnce({ running: false }),
      start: vi.fn(() => ({ pid: 8, port: 20129 })),
      stop: vi.fn(),
    };
    const tray = { initTray: vi.fn((value) => { options = value; return { tray: true }; }) };
    runTray({ daemon, tray, env: {}, appRoot: "/repo" });
    options.onQuit();
    expect(daemon.stop).not.toHaveBeenCalled();
    options.onStop();
    expect(daemon.stop).toHaveBeenCalledOnce();
    options.onRestart();
    expect(daemon.stop).toHaveBeenCalledTimes(2);
    expect(daemon.start).toHaveBeenCalledOnce();
  });

  it("routes tray controls through the daemon callbacks", () => {
    const callbacks = { onRestart: vi.fn(), onStop: vi.fn() };
    handleClick(MENU_INDEX.RESTART, callbacks);
    handleClick(MENU_INDEX.STOP, callbacks);
    expect(callbacks.onRestart).toHaveBeenCalledOnce();
    expect(callbacks.onStop).toHaveBeenCalledOnce();
  });
});

describe("Showdar Router tray", () => {
  it("exposes the required control-plane menu without legacy branding", () => {
    const labels = buildMenuItems(20129, true).map((item) => item.title);
    expect(labels).toEqual([
      "Showdar Router",
      "Server: Running",
      "http://localhost:20129",
      "Open Dashboard",
      "Open Logs",
      "Restart Server",
      "Stop Server",
      "Quit Tray",
    ]);
    expect(labels.join(" ")).not.toMatch(/9router|9r/i);
  });
});
