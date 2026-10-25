// PR #24 review finding P1: the automatic-fallback toggle must not diverge from
// the persisted setting. These tests drive the persistence helper with a fake
// fetch: successful save, rejected PATCH, network failure, and rapid toggles.
import { describe, it, expect, vi } from "vitest";
import { createAutoFallbackWriter } from "../../src/shared/utils/autoFallback.js";

const patchResponse = (value) => ({
  ok: true,
  status: 200,
  json: async () => ({ capacityAdapterAutoFallback: value }),
});
const getResponse = (value) => ({
  ok: true,
  status: 200,
  json: async () => ({ capacityAdapterAutoFallback: value }),
});
const errorResponse = (status) => ({
  ok: false,
  status,
  json: async () => ({ error: "rejected" }),
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("automatic fallback persistence", () => {
  it("commits a successful save using the server's persisted value", async () => {
    const fetchImpl = vi.fn(async () => patchResponse(true));
    const writer = createAutoFallbackWriter({ fetchImpl });

    const result = await writer(true);

    expect(result).toMatchObject({ ok: true, stale: false, persisted: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ capacityAdapterAutoFallback: true });
  });

  it("reports a rejected PATCH and refetches the persisted setting", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(getResponse(true));
    const writer = createAutoFallbackWriter({ fetchImpl });

    const result = await writer(false);

    expect(result.ok).toBe(false);
    expect(result.stale).toBe(false);
    expect(result.persisted).toBe(true); // server truth: still ON, never silently off
    expect(result.error).toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1]).toBeUndefined(); // GET, not another PATCH
  });

  it("treats an unauthorized PATCH as a failure, not a silent success", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(errorResponse(401))
      .mockResolvedValueOnce(getResponse(false));
    const writer = createAutoFallbackWriter({ fetchImpl });

    const result = await writer(true);

    expect(result).toMatchObject({ ok: false, stale: false, persisted: false });
  });

  it("recovers from a network failure by refetching persisted state", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(getResponse(false));
    const writer = createAutoFallbackWriter({ fetchImpl });

    const result = await writer(true);

    expect(result).toMatchObject({ ok: false, stale: false, persisted: false });
    expect(result.error.message).toBe("network down");
  });

  it("still reports failure when both the PATCH and the recovery GET fail", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("network still down"));
    const writer = createAutoFallbackWriter({ fetchImpl });

    const result = await writer(true);

    expect(result).toMatchObject({ ok: false, stale: false });
    expect(result.persisted).toBeUndefined();
  });

  it("serializes rapid toggles so the last intent is the persisted one", async () => {
    const resolvers = [];
    const fetchImpl = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
    const writer = createAutoFallbackWriter({ fetchImpl });

    const first = writer(false);
    const second = writer(true);
    await flush();

    // Only one PATCH is in flight; the second waits for the first to settle.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ capacityAdapterAutoFallback: false });

    resolvers[0](patchResponse(false));
    await expect(first).resolves.toMatchObject({ ok: true, stale: true });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ capacityAdapterAutoFallback: true });

    resolvers[1](patchResponse(true));
    await expect(second).resolves.toMatchObject({ ok: true, stale: false, persisted: true });
  });

  it("does not let a stale failure roll the UI back over a newer toggle", async () => {
    const resolvers = [];
    const fetchImpl = vi.fn(() => new Promise((resolve) => resolvers.push(resolve)));
    const writer = createAutoFallbackWriter({ fetchImpl });

    const first = writer(true);
    const second = writer(false);
    await flush();

    resolvers[0](errorResponse(500));
    await flush();
    resolvers[1](getResponse(true)); // recovery GET inside the failed request
    const staleFailure = await first;
    // Stale request refetches persistence, but the caller must ignore it.
    expect(staleFailure.stale).toBe(true);
    expect(staleFailure.ok).toBe(false);
    expect(staleFailure.persisted).toBe(true);

    await flush();
    resolvers[2](patchResponse(false));
    await expect(second).resolves.toMatchObject({ ok: true, stale: false, persisted: false });
  });
});
