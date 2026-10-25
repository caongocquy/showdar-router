import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initTray } from "../../cli/src/cli/tray/tray.js";
import { ensureTrayRuntime } from "../../cli/hooks/trayRuntime.js";
import { summarizeNpmError } from "../../cli/hooks/sqliteRuntime.js";
import { runWarmup } from "../../cli/hooks/postinstall.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, "..", "..", "cli", "cli.js");

// Minimal systray stand-in. Only the members initUnixTray/killTray touch.
function fakeSystray({ ready = () => Promise.resolve(), legacy } = {}) {
  return class FakeSysTray {
    constructor() {
      this.killed = false;
    }
    onClick() {}
    ready() {
      return ready();
    }
    onReady(cb) {
      if (legacy === "resolve") setTimeout(cb, 0);
    }
    onError(cb) {
      if (legacy === "reject") setTimeout(() => cb(new Error("binary crashed")), 0);
    }
    kill() {
      this.killed = true;
    }
  };
}

describe("tray init never reports a tray that failed", () => {
  it("fails when the systray binary is missing", async () => {
    const result = await initTray({ port: 21298 }, {
      platform: "darwin",
      resolveSystrayFn: () => null,
    });
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("systray2");
  });

  it("fails when ready() rejects", async () => {
    const result = await initTray({ port: 21298 }, {
      platform: "darwin",
      resolveSystrayFn: () => ({
        mod: fakeSystray({ ready: () => Promise.reject(new Error("spawn EACCES")) }),
        isV2: true,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("EACCES");
  });

  it("fails when ready() never resolves (timeout)", async () => {
    const result = await initTray({ port: 21298 }, {
      platform: "darwin",
      readyTimeoutMs: 20,
      resolveSystrayFn: () => ({
        mod: fakeSystray({ ready: () => new Promise(() => {}) }),
        isV2: true,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain("not ready");
  });

  it("resolves ok only after ready() resolves", async () => {
    const result = await initTray({ port: 21298 }, {
      platform: "darwin",
      resolveSystrayFn: () => ({ mod: fakeSystray(), isV2: true }),
    });
    expect(result).toEqual({ ok: true });
  });

  it("supports the legacy onReady/onError path", async () => {
    const okResult = await initTray({ port: 21298 }, {
      platform: "darwin",
      resolveSystrayFn: () => ({
        mod: fakeSystray({ legacy: "resolve" }),
        isV2: false,
      }),
    });
    expect(okResult).toEqual({ ok: true });

    const failed = await initTray({ port: 21298 }, {
      platform: "darwin",
      resolveSystrayFn: () => ({
        mod: fakeSystray({ legacy: "reject" }),
        isV2: false,
      }),
    });
    expect(failed.ok).toBe(false);
    expect(failed.error.message).toContain("binary crashed");
  });

  it("fails on unsupported platforms and Linux without DISPLAY", async () => {
    expect((await initTray({ port: 1 }, { platform: "aix" })).ok).toBe(false);
    const savedDisplay = process.env.DISPLAY;
    delete process.env.DISPLAY;
    try {
      const result = await initTray({ port: 1 }, { platform: "linux" });
      expect(result.ok).toBe(false);
      expect(result.error.message).toContain("DISPLAY");
    } finally {
      if (savedDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = savedDisplay;
    }
  });
});

describe("tray runtime install failures are reported, not swallowed", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-tray-runtime-"));
    process.env.DATA_DIR = tempDir;
    delete process.env.SHOWDAR_ROUTER_SKIP_RUNTIME_INSTALL;
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("skips systray runtime installation on Windows", () => {
    const install = vi.fn(() => { throw new Error("Windows must not install systray"); });
    const result = ensureTrayRuntime({ silent: true, platform: "win32", install });
    expect(result).toEqual({ systray: false, skipped: true });
    expect(install).not.toHaveBeenCalled();
  });

  it("returns systray:false when npm install fails", () => {
    const install = vi.fn(() => false);
    const result = ensureTrayRuntime({ silent: true, platform: "darwin", install });
    expect(install).toHaveBeenCalledOnce();
    expect(result.systray).toBe(false);
  });

  it("returns an error instead of throwing when the runtime dir is not writable", () => {
    // Mirrors npmInstall -> ensureRuntimeDir throwing EACCES on a root-owned prefix.
    const denied = Object.assign(
      new Error("EACCES: permission denied, mkdir '/opt/homebrew/lib/node_modules/showdar-router/runtime'"),
      { code: "EACCES" },
    );
    const result = ensureTrayRuntime({ silent: true, platform: "darwin", install: () => { throw denied; } });
    expect(result.systray).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toMatch(/EACCES|EPERM|permission/i);
  });

  it("EACCES summary names the exact path and forbids sudo", () => {
    const summary = summarizeNpmError(
      "npm ERR! code EACCES\nnpm ERR! path /opt/homebrew/lib/node_modules/showdar-router\nnpm ERR! syscall mkdir",
    );
    expect(summary).toContain("/opt/homebrew/lib/node_modules/showdar-router");
    expect(summary).toContain("do not use sudo");
  });

  it("postinstall warm-up stays non-fatal and prints the permission hint", () => {
    const log = vi.fn();
    const warn = vi.fn();
    expect(() => runWarmup({
      sqlite: () => { throw new Error("EACCES: /opt/homebrew/lib"); },
      tray: () => { throw new Error("EACCES: /opt/homebrew/lib"); },
      log,
      warn,
    })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls.flat().join("\n")).toContain("do not use sudo");
  });
});

describe("cli.js gates the tray success message on a real result", () => {
  it("only prints 'running in system tray' after tray.ok", () => {
    const source = fs.readFileSync(cliPath, "utf8");
    const guardIndex = source.indexOf("if (!tray.ok)");
    const successIndex = source.indexOf("running in system tray");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(successIndex).toBeGreaterThan(guardIndex);
    // Tray-only mode must exit instead of pretending the router is in the tray.
    expect(source).toContain("Tray-only mode (--tray) cannot continue without a tray icon.");
    expect(source).toContain("process.exit(1)");
  });
});
