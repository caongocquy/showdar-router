import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const previousDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-router-revalidation-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("connection health revalidation", () => {
  it("clears stale health only after an explicit successful revalidation", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const connection = await db.createProviderConnection({
      provider: "revalidation-test", authType: "apikey", name: "health", apiKey: "key",
      backoffLevel: 4, rateLimitedUntil: future, errorCode: 429, lastError: "old", lastErrorAt: future,
    });
    await db.updateProviderConnection(connection.id, { modelLock_modelA: future, modelLock_modelB: future });

    await db.updateProviderConnection(connection.id, { displayName: "renamed" });
    let unchanged = await db.getProviderConnectionById(connection.id);
    expect(unchanged.modelLock_modelA).toBe(future);
    expect(unchanged.backoffLevel).toBe(4);

    await db.revalidateProviderConnection(connection.id, { lastError: "failed" }, false);
    unchanged = await db.getProviderConnectionById(connection.id);
    expect(unchanged.lastError).toBe("failed");
    expect(unchanged.modelLock_modelA).toBe(future);

    await db.revalidateProviderConnection(connection.id, { displayName: "verified" }, true);
    const healthy = await db.getProviderConnectionById(connection.id);
    expect(healthy.displayName).toBe("verified");
    expect(healthy.modelLock_modelA).toBeNull();
    expect(healthy.modelLock_modelB).toBeNull();
    expect(healthy.rateLimitedUntil).toBeNull();
    expect(healthy.backoffLevel).toBe(0);
    expect(healthy.errorCode).toBeNull();
    expect(healthy.lastError).toBeNull();
    expect(healthy.testStatus).toBe("active");

  });

  it("preserves an explicit successful-test warning while clearing stale health", async () => {
    const connection = await db.createProviderConnection({
      provider: "revalidation-warning-test", authType: "apikey", name: "warning", apiKey: "key",
      lastError: "stale failure", lastErrorAt: new Date().toISOString(), errorCode: 429,
    });

    await db.revalidateProviderConnection(connection.id, {
      testStatus: "active",
      lastError: "Connected, but credits are exhausted",
      lastErrorAt: new Date().toISOString(),
    }, true);

    const healthy = await db.getProviderConnectionById(connection.id);
    expect(healthy.testStatus).toBe("active");
    expect(healthy.lastError).toBe("Connected, but credits are exhausted");
    expect(healthy.lastErrorAt).toBeTruthy();
    expect(healthy.errorCode).toBeNull();
  });
});
