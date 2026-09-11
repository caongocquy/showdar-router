import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";
import { createModelDiscovery } from "../../src/app/api/providers/suggested-models/service.js";
import { GET } from "../../src/app/api/providers/suggested-models/route.js";

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

const registry = [
  { id: "openrouter", modelsFetcher: { url: "https://openrouter.ai/api/v1/models", type: "openrouter-free" } },
  { id: "opencode", modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" } },
  { id: "mimo-free", modelsFetcher: { url: "https://models.dev/api.json", type: "mimo-free" } },
  { id: "without-models", category: "apikey" },
];

const openRouterModels = [
  { id: "small", name: "Small", context_length: 199999, pricing: { prompt: "0", completion: "0" } },
  { id: "prompt-paid", name: "Prompt paid", context_length: 500000, pricing: { prompt: "0.1", completion: "0" } },
  { id: "completion-paid", name: "Completion paid", context_length: 500000, pricing: { prompt: "0", completion: "0.1" } },
  { id: "large", name: "Large", context_length: 1000000, pricing: { prompt: "0", completion: "0" } },
  { id: "minimum", name: "Minimum", context_length: 200000, pricing: { prompt: "0", completion: "0" } },
];

describe("provider model discovery", () => {
  afterEach(() => vi.useRealTimers());

  it("normalizes and filters OpenRouter free models", () => {
    expect(FILTERS["openrouter-free"](openRouterModels)).toEqual([
      { id: "large", name: "Large", contextLength: 1000000 },
      { id: "minimum", name: "Minimum", contextLength: 200000 },
    ]);
  });

  it("preserves OpenCode free, special, dead, and optional context metadata", () => {
    expect(FILTERS["opencode-free"]([
      { id: "foo-free", name: "Foo", context_length: 300000 },
      { id: "big-pickle", name: "Big Pickle" },
      { id: "deepseek-v4-flash-free", name: "Dead" },
      { id: "paid", name: "Paid" },
    ])).toEqual([
      { id: "foo-free", name: "Foo", contextLength: 300000 },
      { id: "big-pickle", name: "Big Pickle" },
    ]);
  });

  it("keeps MiMo inclusion behavior while normalizing models", () => {
    expect(FILTERS["mimo-free"]([
      { id: "mimo-v1", name: "MiMo V1", context_length: "128000" },
      { id: "other", name: "MiMo Compatible" },
      { id: "unrelated", name: "Other" },
    ])).toEqual([
      { id: "mimo-v1", name: "MiMo V1", contextLength: 128000 },
      { id: "other", name: "MiMo Compatible" },
    ]);
  });

  it("resolves the exact registry URL and ignores arbitrary url/type input", async () => {
    const fetchImpl = vi.fn(async (url) => jsonResponse({ data: openRouterModels }));
    const discovery = createModelDiscovery({ registry, fetchImpl });

    await expect(discovery.discover("openrouter", {
      url: "https://attacker.example/steal",
      type: "opencode-free",
    })).resolves.toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({ signal: expect.any(AbortSignal), redirect: "error" })
    );
    expect(fetchImpl.mock.calls[0][0]).not.toContain("attacker.example");
  });

  it("does not fetch unknown or no-fetcher providers", async () => {
    const fetchImpl = vi.fn();
    const discovery = createModelDiscovery({ registry, fetchImpl });

    await expect(discovery.discover("unknown")).rejects.toMatchObject({ status: 404 });
    await expect(discovery.discover("without-models")).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns controlled 4xx responses without fetching a client URL", async () => {
    const missing = await GET(new Request("http://localhost/api/providers/suggested-models?url=https://attacker.example"));
    const unknown = await GET(new Request("http://localhost/api/providers/suggested-models?providerId=unknown&url=https://attacker.example&type=openrouter-free"));
    expect(missing.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Missing providerId" });
    expect(await unknown.json()).toEqual({ error: "Unknown provider" });
  });

  it("rejects malformed trusted URLs before fetching", async () => {
    const fetchImpl = vi.fn();
    const discovery = createModelDiscovery({
      registry: [{ id: "bad", modelsFetcher: { url: "file:///etc/passwd", type: "openrouter-free" } }],
      fetchImpl,
    });

    await expect(discovery.discover("bad")).rejects.toMatchObject({ status: 500 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts an upstream discovery after ten seconds", async () => {
    vi.useFakeTimers();
    let signal;
    const fetchImpl = vi.fn((_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "AbortError" }))));
    });
    const discovery = createModelDiscovery({ registry, fetchImpl });
    const pending = discovery.discover("openrouter");
    await vi.advanceTimersByTimeAsync(10000);
    await expect(pending).resolves.toEqual([]);
    expect(signal.aborted).toBe(true);
  });

  it("caches successful results for ten minutes and refetches after expiry", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => jsonResponse({ data: openRouterModels }));
    const discovery = createModelDiscovery({ registry, fetchImpl, now: () => now });

    await discovery.discover("openrouter");
    await discovery.discover("openrouter");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 10 * 60 * 1000 + 1;
    await discovery.discover("openrouter");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures and coalesces concurrent misses per provider", async () => {
    let resolveFetch;
    const fetchImpl = vi.fn((url) => url.includes("opencode.ai")
      ? Promise.resolve(jsonResponse({ data: [] }))
      : new Promise((resolve) => { resolveFetch = resolve; }));
    const discovery = createModelDiscovery({ registry, fetchImpl });
    const first = discovery.discover("openrouter");
    const second = discovery.discover("openrouter");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch(jsonResponse({ data: openRouterModels }));
    await Promise.all([first, second]);
    await discovery.discover("opencode");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not let a failed request replace a valid cache entry", async () => {
    let now = 0;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: openRouterModels }))
      .mockResolvedValueOnce(new Response("upstream down", { status: 503 }));
    const discovery = createModelDiscovery({ registry, fetchImpl, now: () => now });

    const first = await discovery.discover("openrouter");
    now = 10 * 60 * 1000 + 1;
    expect(await discovery.discover("openrouter")).toEqual([]);
    now = 10 * 60 * 1000 + 2;
    expect(await discovery.discover("openrouter")).toEqual([]);
    expect(first).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("uses providerId-only client requests and corrected UI copy", () => {
    const client = fs.readFileSync("src/shared/utils/providerModelsFetcher.js", "utf8");
    const page = fs.readFileSync("src/app/(dashboard)/dashboard/providers/[id]/page.js", "utf8");
    expect(client).toContain("fetchSuggestedModels(providerId)");
    expect(client).toContain("providerId");
    expect(client).not.toContain("searchParams = new URLSearchParams({ url:");
    expect(client).not.toContain("const cache = new Map");
    expect(client).not.toContain("CACHE_TTL_MS");
    expect(page).toContain("fetchSuggestedModels(providerId)");
    expect(page).toContain("if (!providerInfo?.modelsFetcher)");
    expect(page).toContain("setSuggestedModels([])");
    expect(page).toContain("Suggested free models:");
    expect(page).not.toContain("Suggested free models (≥200k context):");
  });
});
