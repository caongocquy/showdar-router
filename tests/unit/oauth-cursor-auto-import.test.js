import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock os
vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

// Mock fs/promises
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("child_process", () => ({ execFile: execFileMock }));

// Shared mock db instance
const mockDbInstance = {
  prepare: vi.fn(),
  close: vi.fn(),
  __throwOnConstruct: false,
};

// Mock better-sqlite3 as a class so `new Database(...)` works.
vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    constructor() {
      if (mockDbInstance.__throwOnConstruct) {
        throw new Error("SQLITE_CANTOPEN");
      }
      return mockDbInstance;
    }
  },
}));

// We need to dynamically import after mocks are registered
let GET;

const mockTokenRows = (rows) => {
  mockDbInstance.prepare.mockImplementation(() => ({
    get: vi.fn((key) => (rows[key] === undefined ? undefined : { value: rows[key] })),
  }));
};

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbInstance.__throwOnConstruct = false;
    execFileMock.mockImplementation((file, args, options, callback) => {
      callback(new Error(`${file} unavailable`));
    });
    // Force darwin so macOS-specific logic is exercised
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    // Re-import to pick up fresh mocks each run
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    vi.unstubAllGlobals();
  });

  // ── Path probing ─────────────────────────────────────────────────────

  it("returns checked macOS locations when no Cursor database is accessible", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Checked locations:");
    expect(response.body.error.replaceAll("\\", "/")).toContain("Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    expect(response.body.error).toContain("Cursor - Insiders");
  });

  it("treats unsupported platforms as Linux config paths instead of failing", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body.error.replaceAll("\\", "/")).toContain(".config/cursor/User/globalStorage/state.vscdb");
    expect(response.body.error).not.toBe("Unsupported platform");
  });

  // ── better-sqlite3 extraction ────────────────────────────────────────

  it("extracts and normalizes tokens using exact keys", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockTokenRows({
      "cursorAuth/accessToken": '"json-token"',
      "storage.serviceMachineId": '"json-machine-id"',
    });

    const response = await GET();

    expect(response.body).toEqual({
      found: true,
      accessToken: "json-token",
      machineId: "json-machine-id",
    });
    expect(mockDbInstance.prepare).toHaveBeenCalledWith(expect.stringContaining("itemTable"));
    expect(mockDbInstance.close).toHaveBeenCalled();
  });

  it("falls back to the manual import contract when the database opens but has no tokens", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockTokenRows({});

    const response = await GET();

    expect(response.body).toEqual(expect.objectContaining({
      found: false,
      windowsManual: true,
      dbPath: expect.stringContaining("state.vscdb"),
    }));
  });

  it("falls back to the sqlite3 CLI when better-sqlite3 cannot open the database", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__throwOnConstruct = true;
    execFileMock.mockImplementation((file, args, options, callback) => {
      if (file !== "sqlite3") return callback(new Error("not found"));
      const sql = args[1] || "";
      if (sql.includes("accessToken")) return callback(null, { stdout: '"cli-token"' });
      if (sql.includes("machineId")) return callback(null, { stdout: '"cli-machine"' });
      return callback(null, { stdout: "" });
    });

    const response = await GET();

    expect(response.body).toEqual({
      found: true,
      accessToken: "cli-token",
      machineId: "cli-machine",
    });
  });

  it("offers manual import when neither extraction strategy works", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__throwOnConstruct = true;

    const response = await GET();

    expect(response.body).toEqual(expect.objectContaining({
      found: false,
      windowsManual: true,
      dbPath: expect.stringContaining("state.vscdb"),
    }));
  });

  // ── Linux installation guard ─────────────────────────────────────────

  it("rejects leftover Linux config when Cursor is not installed", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockImplementation((path) =>
      String(path).includes("state.vscdb")
        ? Promise.resolve()
        : Promise.reject(new Error("ENOENT")));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("does not appear to be installed");
  });
});
