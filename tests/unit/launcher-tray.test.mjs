import { describe, expect, it, vi } from "vitest";
import { getLaunchMode, interfaceItems, ensureDaemon, runTray, dashboardUrl, getTrayChildArgs } from "../../cli/src/launcher.js";
import { buildMenuItems, handleClick, MENU_INDEX } from "../../cli/src/cli/tray/tray.js";

describe("Showdar Router launcher", () => {
  it("uses the interactive selector only for a TTY with no arguments", () => {
    expect(getLaunchMode([], true)).toBe("interactive");
    expect(getLaunchMode([], false)).toBe("start");
    expect(getLaunchMode(["start"], true)).toBe("start");
    expect(getLaunchMode(["tray"], true)).toBe("tray");
    expect(getLaunchMode(["--port", "30000"], true)).toBe("start");
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
      DEFAULT_PORT: 21298,
      status: vi.fn(() => ({ running: false })),
      start: vi.fn(() => ({ pid: 42, port: 21299 })),
    };
    const tray = { initTray: vi.fn(() => ({ tray: true })) };
    const result = runTray({ daemon, tray, env: {}, appRoot: "/repo" });
    expect(result.tray).toEqual({ tray: true });
    expect(daemon.start).toHaveBeenCalledOnce();
    expect(tray.initTray).toHaveBeenCalledWith(expect.objectContaining({ port: 21299, running: true }));
  });

  it("builds dashboard URLs from the active daemon port", () => {
    expect(dashboardUrl(21299)).toBe("http://localhost:21299/dashboard");
  });

  it("converts the tray command into a detached child command", () => {
    expect(getTrayChildArgs(["tray", "--port", "30000"])).toEqual(["--tray", "--port", "30000"]);
  });

  it("does not start a duplicate daemon when attaching to a running server", () => {
    const daemon = { DEFAULT_PORT: 21298, status: vi.fn(() => ({ running: true, pid: 7, port: 21299 })), start: vi.fn() };
    const tray = { initTray: vi.fn(() => ({ tray: true })) };
    runTray({ daemon, tray, env: {}, appRoot: "/repo" });
    expect(daemon.start).not.toHaveBeenCalled();
  });

  it("stops the daemon when quitting the tray", () => {
    let options;
    const daemon = {
      DEFAULT_PORT: 21298,
      paths: vi.fn(() => ({ logFile: "/tmp/showdar-router.log" })),
      status: vi.fn()
        .mockReturnValueOnce({ running: true, pid: 7 })
        .mockReturnValueOnce({ running: false }),
      start: vi.fn(() => ({ pid: 8, port: 21299 })),
      stop: vi.fn(),
    };
    const tray = { initTray: vi.fn((value) => { options = value; return { tray: true }; }) };
    runTray({ daemon, tray, env: {}, appRoot: "/repo" });
    options.onQuit();
    expect(daemon.stop).toHaveBeenCalledOnce();
  });

  it("routes tray controls through the daemon callbacks", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
    const callbacks = { onRestart: vi.fn(), onStop: vi.fn() };
    try {
      handleClick(MENU_INDEX.RESTART, callbacks);
      await handleClick(MENU_INDEX.STOP, callbacks);
      expect(callbacks.onRestart).toHaveBeenCalledOnce();
      expect(callbacks.onStop).toHaveBeenCalledOnce();
    } finally {
      exit.mockRestore();
    }
  });

  it("exits the tray after stopping the server", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
    const onStop = vi.fn();
    try {
      await handleClick(MENU_INDEX.STOP, { onStop, port: 21298 });
      expect(onStop).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  });

  it("handles systray click events when only the clicked item is provided", () => {
    const callbacks = { onOpenDashboard: vi.fn() };
    handleClick({ seq_id: 99, item: { title: "Open Dashboard" } }, { ...callbacks, port: 21298 });
    expect(callbacks.onOpenDashboard).toHaveBeenCalledOnce();
  });
});

describe("Showdar Router tray", () => {
  it("exposes the required control-plane menu without legacy branding", () => {
    const labels = buildMenuItems(21298, true).map((item) => item.title);
    expect(labels).toEqual([
      "Showdar Router",
      "Server: Running",
      "http://localhost:21298",
      "Open Dashboard",
      "Open Logs",
      "Restart Server",
      "Stop Server",
      "Quit Tray",
    ]);
    expect(labels.join(" ")).not.toMatch(/9router|9r/i);
  });
});
