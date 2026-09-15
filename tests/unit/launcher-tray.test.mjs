import { describe, expect, it, vi } from "vitest";
import { buildMenuItems, handleClick, MENU_INDEX } from "../../cli/src/cli/tray/tray.js";

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

  it("handles menu clicks for dashboard, logs, restart, stop, quit", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
    const callbacks = { onRestart: vi.fn(), onStop: vi.fn(), onQuit: vi.fn(), onOpenDashboard: vi.fn(), onOpenLogs: vi.fn() };
    try {
      handleClick(MENU_INDEX.DASHBOARD, callbacks);
      expect(callbacks.onOpenDashboard).toHaveBeenCalledOnce();

      handleClick(MENU_INDEX.LOGS, callbacks);
      expect(callbacks.onOpenLogs).toHaveBeenCalledOnce();

      handleClick(MENU_INDEX.RESTART, callbacks);
      expect(callbacks.onRestart).toHaveBeenCalledOnce();

      await handleClick(MENU_INDEX.STOP, callbacks);
      expect(callbacks.onStop).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(0);

      await handleClick(MENU_INDEX.QUIT, callbacks);
      expect(callbacks.onQuit).toHaveBeenCalledOnce();
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