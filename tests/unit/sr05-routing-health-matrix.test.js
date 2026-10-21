// SR-05: routing health, cooldown and account-fallback regression matrix.
//
// Two layers:
//   1. Pure units (route health state, classifier policy, capability planner,
//      account-fallback helpers) with deterministic clocks.
//   2. The real handler/combo path with only the upstream executor, auth DB and
//      settings edges mocked — proves dispatch order, cooldown writes and
//      cancellation/stream compatibility end to end.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
  const conn = (id) => ({ id, connectionId: id, connectionName: id, isActive: true, accessToken: "tok", providerSpecificData: {} });
  return {
    conn,
    fetchMock,
    state: {
      combos: {},
      connections: [conn("conn-1")],
      validateSuccess: null,
      calls: [],
      markCalls: [],
      healthFailures: [],
      healthSuccesses: [],
      healthCancels: [],
    },
  };
});

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor() {
    return {
      noAuth: true,
      async execute({ model, body, stream, credentials, signal }) {
        h.state.calls.push({ model, conn: credentials?.connectionId || null, stream });
        const res = await globalThis.fetch("https://upstream.example/v1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, model }),
          signal,
        });
        return { response: res, url: "https://upstream.example/v1", headers: {}, transformedBody: body };
      },
    };
  },
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({ logClientRawRequest() {}, logRawRequest() {}, logTargetRequest() {}, logProviderResponse() {}, logConvertedResponse() {}, logOpenAIRequest() {}, logConvertedChunk() {}, appendOpenAIChunk() {}, logError() {}, logResponse() {} }),
}));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(async () => {}), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async (_provider, exclude) => h.state.connections.find((c) => !exclude?.has(c.connectionId)) || null),
  markAccountUnavailable: vi.fn(async (id, status) => {
    h.state.markCalls.push({ id, status });
    return { shouldFallback: status === 429 || status >= 500, cooldownMs: 0 };
  }),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({ handleAntigravityQuotaError: vi.fn(async () => 0), clearAntigravityStrikes: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false, comboStrategies: {}, comboStrategy: "fallback", comboStickyRoundRobinLimit: 0, providerThinking: {} })),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async (m) => {
    const i = String(m).indexOf("/");
    return i <= 0 ? { provider: null, model: null } : { provider: m.slice(0, i), model: m.slice(i + 1) };
  }),
  getComboModels: vi.fn(async (name) => h.state.combos[name] || null),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({ updateProviderCredentials: vi.fn(async () => {}), checkAndRefreshToken: vi.fn(async (_p, c) => c) }));
vi.mock("@/sse/services/comboHealthHooks.js", () => ({
  createChatComboHealthHooks: () => ({
    inspectModel: async () => ({ skip: false }),
    beforeModelAttempt: async () => ({ skip: false }),
    onModelSuccess: async (model) => { h.state.healthSuccesses.push(model); },
    onModelFailure: async (model, failure) => { h.state.healthFailures.push({ model, status: failure?.status }); },
    onModelCancelled: async (model) => { h.state.healthCancels.push(model); },
    get validateSuccess() { return h.state.validateSuccess; },
  }),
}));
vi.mock("@/sse/utils/logger.js", async (importOriginal) => ({ ...(await importOriginal()), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), line: vi.fn(), errorLine: vi.fn(), maskKey: () => "****" }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost:1" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("../../open-sse/services/capacityAdapter.js", () => ({ augmentModelsWithCapacityAdapter: vi.fn((m) => m), withCapacityAdapterStripping: vi.fn((f) => f), getActiveAdapterStrategy: vi.fn(() => "fallback") }));
vi.mock("../../open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn(async () => null) }));

const { handleChat } = await import("@/sse/handlers/chat.js");
const { validateChatComboResponse } = await import("../../open-sse/services/chatComboResponseValidator.js");
const { handleComboChat, handleFusionChat, resetComboRotation, detectRequiredCapabilities } = await import("../../open-sse/services/combo.js");
const { planComboCandidates } = await import("../../open-sse/services/comboPlanner.js");
const { RouteHealthState } = await import("../../open-sse/services/routeHealthState.js");
const { checkFallbackError, getEarliestRateLimitedUntil, getQuotaCooldown } = await import("../../open-sse/services/accountFallback.js");
const { classifyRouteFailure } = await import("../../open-sse/services/routeFailureClassifier.js");

const enc = (s) => new TextEncoder().encode(s);
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const base = { object: "chat.completion.chunk", created: 1, model: "test-model" };
const roleFrame = (id = "chatcmpl-1") => frame({ ...base, id, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
const contentFrame = (id, text) => frame({ ...base, id, choices: [{ index: 0, delta: { content: text } }] });
const finishFrame = (id = "chatcmpl-1") => frame({ ...base, id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const successFrames = (id = "chatcmpl-1", text = "hi") => [roleFrame(id), contentFrame(id, text), finishFrame(id), "data: [DONE]\n\n"];

function sseFixture(frames) {
  const tracker = { cancelled: 0, pulls: 0 };
  const body = new ReadableStream({
    pull(c) {
      tracker.pulls += 1;
      if (tracker.pulls <= frames.length) c.enqueue(enc(frames[tracker.pulls - 1]));
      else c.close();
    },
    cancel() { tracker.cancelled += 1; },
  });
  return { response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }), tracker };
}
function brokenSseFixture(frames, error) {
  const body = new ReadableStream({
    pull(c) {
      const i = body.__i = (body.__i || 0) + 1;
      if (i <= frames.length) c.enqueue(enc(frames[i - 1]));
      else c.error(error);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const jsonFixture = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const okJson = (content, status = 200) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status, headers: { "content-type": "application/json" } });

function runChat({ model, stream = true, signal } = {}) {
  const req = new Request("http://localhost:21298/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "q" }] }),
    signal,
  });
  return handleChat(req);
}

function combo(models = ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"]) {
  h.state.combos["mycombo"] = models;
  h.state.connections = [h.conn("conn-1")];
  h.state.validateSuccess = validateChatComboResponse;
  h.state.calls = [];
  h.state.markCalls = [];
  h.state.healthFailures = [];
  h.state.healthSuccesses = [];
  h.state.healthCancels = [];
  h.fetchMock.mockReset();
}

async function drain(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch { /* post-commit truncation is part of the contract */ }
  return text;
}
const terminalCount = (text) => text.split("\n\n").filter((b) => b.trim() === "data: [DONE]").length;
const contentOf = (text) => text
  .split("\n\n").map((b) => b.trim()).filter((b) => b.startsWith("data: {"))
  .map((b) => { try { return JSON.parse(b.slice(5).trim()); } catch { return null; } })
  .filter(Boolean).flatMap((p) => (p.choices || []).map((c) => c.delta?.content || "")).join("");

const log = { info() {}, warn() {}, debug() {} };
const storage = () => {
  const values = {};
  return { async getAll() { return { ...values }; }, async set(k, v) { values[k] = v; }, async remove(k) { delete values[k]; }, async clear() { for (const k of Object.keys(values)) delete values[k]; } };
};
const fixedNow = Date.parse("2026-09-10T00:00:00.000Z");

beforeEach(() => {
  resetComboRotation();
});

describe("SR-05 A — ordered fallback by status", () => {
  it.each([429, 502, 503, 504])("falls back after %i, preserving configured order", async (status) => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => jsonFixture({ error: { message: `upstream ${status}` } }, status))
      .mockImplementationOnce(async () => sseFixture(successFrames("chatcmpl-2", "second")).response);

    const res = await runChat({ model: "mycombo" });
    const text = await drain(res);

    expect(res.status).toBe(200);
    expect(h.state.calls.map((c) => c.model)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(contentOf(text)).toBe("second");
    expect(text).not.toContain(`upstream ${status}`);
    expect(h.state.healthFailures).toEqual([{ model: "deepseek/deepseek-chat", status }]);
  }, 10000);

  it("falls back after a network error before headers", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => { throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); })
      .mockImplementationOnce(async () => sseFixture(successFrames("chatcmpl-2", "ok")).response);

    const res = await runChat({ model: "mycombo" });

    expect(res.status).toBe(200);
    expect(h.state.calls).toHaveLength(2);
    expect(contentOf(await drain(res))).toBe("ok");
  }, 10000);

  it("treats a connect timeout as a retryable provider failure", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => { throw Object.assign(new Error("fetch connect timeout after 60000ms"), { name: "TimeoutError", status: 502 }); })
      .mockImplementationOnce(async () => sseFixture(successFrames("chatcmpl-2", "ok")).response);

    const res = await runChat({ model: "mycombo" });

    expect(res.status).toBe(200);
    expect(h.state.calls).toHaveLength(2);
    expect(h.state.healthFailures).toEqual([{ model: "deepseek/deepseek-chat", status: 502 }]);
  }, 10000);

  it("does not fall back on a non-chainable invalid-request error", async () => {
    combo();
    h.fetchMock.mockImplementationOnce(async () => jsonFixture({ error: { message: "invalid request: messages must be an array" } }, 400));

    const res = await runChat({ model: "mycombo" });

    expect(res.status).toBe(400);
    expect(h.state.calls).toHaveLength(1);
    expect(h.state.healthFailures).toHaveLength(1);
  }, 10000);

  it("returns the last status when every candidate is exhausted", async () => {
    combo();
    h.fetchMock.mockImplementation(async () => jsonFixture({ error: { message: "rate limit exceeded" } }, 429));

    const res = await runChat({ model: "mycombo" });

    expect(res.status).toBe(429);
    expect(h.state.calls).toHaveLength(2);
    expect(h.state.healthFailures.map((f) => f.model)).toEqual(["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"]);
  }, 10000);
});

describe("SR-05 B — round-robin cursor semantics", () => {
  const rr = (overrides = {}) => handleComboChat({
    body: { messages: [{ role: "user", content: "q" }] },
    models: ["p/a", "p/b"],
    comboStrategy: "round-robin",
    comboName: "rr",
    log,
    handleSingleModel: async (_body, model) => okJson(model),
    ...overrides,
  });

  it("advances the primary once per request and cycles both models", async () => {
    const order = [];
    const call = (extra = {}) => rr({ ...extra, handleSingleModel: async (_b, model) => { order.push(model); return okJson(model); } });

    await call();
    await call();

    expect(order).toEqual(["p/a", "p/b"]);
  });

  it("skips an unhealthy primary without jumping the cursor", async () => {
    const order = [];
    const unhealthy = new Set(["p/b"]);
    const beforeModelAttempt = async (model) => ({ skip: unhealthy.has(model), reason: "cooldown", nextProbeAt: new Date(Date.now() + 60_000).toISOString() });
    const call = () => rr({ beforeModelAttempt, handleSingleModel: async (_b, model) => { order.push(model); return okJson(model); } });

    await call(); // cursor p/a
    await call(); // cursor p/b → skipped → p/a, cursor stays p/b
    unhealthy.delete("p/b");
    await call(); // cursor p/b → healthy

    expect(order).toEqual(["p/a", "p/a", "p/b"]);
  });

  it("keeps the next primary after a failure fallback", async () => {
    const order = [];
    let first = true;
    const call = () => rr({
      handleSingleModel: async (_b, model) => {
        order.push(model);
        if (model === "p/a" && first) { first = false; return jsonFixture({ error: { message: "bad gateway" } }, 502); }
        return okJson(model);
      },
    });

    await call(); // p/a fails → p/b succeeds
    await call(); // cursor is now p/b

    expect(order).toEqual(["p/a", "p/b", "p/b"]);
  });

  it("keeps the next primary after a client cancellation", async () => {
    const order = [];
    const ctrl = new AbortController();
    const cancelled = await rr({
      requestSignal: ctrl.signal,
      handleSingleModel: async (_b, model) => {
        order.push(model);
        if (model === "p/a") { ctrl.abort(); return jsonFixture({ error: { message: "Request aborted" } }, 499); }
        return okJson(model);
      },
    });
    expect(cancelled.status).toBe(499);

    await rr({ handleSingleModel: async (_b, model) => { order.push(model); return okJson(model); } });

    expect(order).toEqual(["p/a", "p/b"]);
  }, 10000);
});

describe("SR-05 C — fusion eligibility", () => {
  it("degrades to the single eligible model instead of fanning out", async () => {
    const dispatched = [];
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "q" }] },
      models: ["p/a", "p/b"],
      comboName: "f",
      log,
      inspectModel: async (model) => model === "p/b" ? { skip: true, reason: "cooldown", nextProbeAt: new Date(Date.now() + 60_000).toISOString() } : { skip: false },
      handleSingleModel: async (_b, model) => { dispatched.push(model); return okJson(model); },
      validateSuccess: undefined,
    });

    expect(res.status).toBe(200);
    expect(dispatched).toEqual(["p/a"]);
  }, 10000);
});

describe("SR-05 D — account fallback and reset metadata", () => {
  it("moves to the next account after an exhausted account", async () => {
    combo(["deepseek/deepseek-chat"]);
    h.state.connections = [h.conn("conn-1"), h.conn("conn-2")];
    h.fetchMock
      .mockImplementationOnce(async () => jsonFixture({ error: { message: "rate limit exceeded" } }, 429))
      .mockImplementationOnce(async () => sseFixture(successFrames("chatcmpl-2", "ok")).response);

    const res = await runChat({ model: "mycombo" });

    expect(res.status).toBe(200);
    expect(h.state.calls.map((c) => c.conn)).toEqual(["conn-1", "conn-2"]);
    expect(h.state.markCalls).toEqual([{ id: "conn-1", status: 429 }]);
  }, 10000);

  it("reports exhaustion after every account fails", async () => {
    combo(["deepseek/deepseek-chat"]);
    h.state.connections = [h.conn("conn-1"), h.conn("conn-2")];
    h.fetchMock.mockImplementation(async () => jsonFixture({ error: { message: "rate limit exceeded" } }, 429));

    const res = await runChat({ model: "mycombo" });

    expect(res.status).toBe(429);
    expect(h.state.calls.map((c) => c.conn)).toEqual(["conn-1", "conn-2"]);
    expect(h.state.markCalls).toEqual([{ id: "conn-1", status: 429 }, { id: "conn-2", status: 429 }]);
  }, 10000);

  it.each([
    [429, "rate limit exceeded", true],
    [500, "internal error", true],
    [502, "bad gateway", true],
    [503, "service unavailable", true],
    [504, "gateway timeout", true],
    [401, "invalid api key", true],
    [400, "invalid request: malformed field", false],
  ])("classifies status %i as fallback=%s", (status, text, shouldFallback) => {
    expect(checkFallbackError(status, text).shouldFallback).toBe(shouldFallback);
  });

  it("backs off exponentially for repeated rate limits", () => {
    const first = checkFallbackError(429, "rate limit exceeded", 0);
    const second = checkFallbackError(429, "rate limit exceeded", 1);

    expect(first.shouldFallback).toBe(true);
    expect(second.newBackoffLevel).toBe(first.newBackoffLevel + 1);
    expect(second.cooldownMs).toBeGreaterThan(first.cooldownMs);
    expect(getQuotaCooldown(99)).toBe(getQuotaCooldown(200)); // clamped at the policy ceiling
  });

  it("propagates the earliest future reset across mixed account states", () => {
    const now = Date.now();
    const earliest = new Date(now + 30_000).toISOString();
    const later = new Date(now + 90_000).toISOString();

    expect(getEarliestRateLimitedUntil([
      { rateLimitedUntil: new Date(now - 1_000).toISOString() }, // expired
      { rateLimitedUntil: later },
      { rateLimitedUntil: earliest },
      {},
    ])).toBe(earliest);
    expect(getEarliestRateLimitedUntil([
      { rateLimitedUntil: new Date(now - 5_000).toISOString() },
      {},
    ])).toBeNull();
  });
});

describe("SR-05 E — health transitions and half-open probes", () => {
  it("moves healthy → cooldown → half-open → healthy on a fixed clock", async () => {
    const state = new RouteHealthState(storage());
    await state.recordFailure("p/m", { reason: "transient_rate_limit", routeState: "cooldown", routeCooldownMs: 60_000, effectiveStatus: 429 }, null, fixedNow);

    expect(state.inspect("p/m", fixedNow).skip).toBe(true);
    expect(state.inspect("p/m", fixedNow + 60_000).skip).toBe(false);

    const probe = await state.beforeAttempt("p/m", fixedNow + 60_000);
    expect(probe.probe).toBe(true);
    expect((await state.beforeAttempt("p/m", fixedNow + 60_001)).skip).toBe(true); // lease held

    await state.recordSuccess("p/m", probe.probeToken);
    expect(state.inspect("p/m", fixedNow + 60_002).skip).toBe(false);
    expect(await state.snapshot()).toEqual({});
  });

  it("re-cooldowns with an incremented failure count when the probe fails", async () => {
    const state = new RouteHealthState(storage());
    await state.recordFailure("p/m", { reason: "transient_rate_limit", routeState: "cooldown", routeCooldownMs: 60_000, effectiveStatus: 429 }, null, fixedNow);
    const probe = await state.beforeAttempt("p/m", fixedNow + 60_000);

    const record = await state.recordFailure(
      "p/m",
      { reason: "transient_rate_limit", routeState: "cooldown", routeCooldownMs: 120_000, effectiveStatus: 429 },
      null,
      fixedNow + 60_500,
      "still limited",
      probe.probeToken,
    );

    expect(record.failureCount).toBe(2);
    expect(record.nextProbeAt).toBe(new Date(fixedNow + 60_500 + 120_000).toISOString());
    expect(state.inspect("p/m", fixedNow + 60_501).skip).toBe(true);
  });

  it("keeps provider/model health keys independent", async () => {
    const state = new RouteHealthState(storage());
    await state.recordFailure("p/a", { reason: "transient_rate_limit", routeState: "cooldown", routeCooldownMs: 60_000, effectiveStatus: 429 }, null, fixedNow);

    expect(state.inspect("p/b", fixedNow).skip).toBe(false);
    expect(state.inspect("p/a", fixedNow).skip).toBe(true);
    await state.recordSuccess("p/b");
    expect(state.inspect("p/a", fixedNow).skip).toBe(true);
  });

  it("classifies request-scope failures without a route cooldown", () => {
    expect(classifyRouteFailure(400, "invalid request: malformed field")).toMatchObject({ scope: "request", chainable: false, routeCooldownMs: 0 });
    expect(classifyRouteFailure(429, "rate limit exceeded")).toMatchObject({ scope: "credential", reason: "transient_rate_limit" });
    expect(classifyRouteFailure(502, "bad gateway")).toMatchObject({ reason: "provider_capacity" });
  });
});

describe("SR-05 F — capability eligibility", () => {
  it.each([
    [{ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] }, ["vision"]],
    [{ messages: [{ role: "user", content: [{ type: "input_image" }] }] }, ["vision"]],
    [{ messages: [{ role: "user", content: [{ type: "file", file: { file_data: "data:application/pdf;base64,AA" } }] }] }, ["pdf"]],
    [{ messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { format: "wav" } }] }] }, ["audioInput"]],
    [{ messages: [{ role: "user", content: [{ type: "video_url", video_url: { url: "https://x/v.mp4" } }] }] }, ["videoInput"]],
    [{ messages: [{ role: "user", content: "plain text" }], tools: [{ type: "web_search" }] }, ["search"]],
    [{ messages: [{ role: "user", content: "plain text" }] }, []],
  ])("detects required capabilities for %#", (body, expected) => {
    expect([...detectRequiredCapabilities(body)].sort()).toEqual([...expected].sort());
  });

  it("drops candidates missing a hard capability while preserving order", async () => {
    const caps = { "p/vision": { vision: true }, "p/text": {}, "p/all": { vision: true, pdf: true } };
    const plan = await planComboCandidates({
      models: ["p/text", "p/vision", "p/all"],
      requiredCapabilities: new Set(["vision"]),
      getCapabilities: (provider, model) => caps[`${provider}/${model}`] || {},
    });

    expect(plan.models).toEqual(["p/vision", "p/all"]);
    expect(plan.missingCapabilities).toEqual([]);
  });

  it("does not exclude candidates for advisory capabilities like tools or search", async () => {
    const caps = { "p/a": { tools: false, search: false }, "p/b": { tools: true, search: true } };
    const plan = await planComboCandidates({
      models: ["p/a", "p/b"],
      requiredCapabilities: new Set(["tools", "search"]),
      getCapabilities: (provider, model) => caps[`${provider}/${model}`] || {},
    });

    // Only vision/pdf/audio/video are pre-dispatch hard filters; tools and
    // search stay advisory so a conservative registry flag cannot drop routes.
    expect(plan.models).toEqual(["p/a", "p/b"]);
  });

  it("reports hard-capability mismatch when nothing qualifies", async () => {
    const plan = await planComboCandidates({
      models: ["p/text"],
      requiredCapabilities: new Set(["vision"]),
      getCapabilities: () => ({}),
    });

    expect(plan.models).toEqual([]);
    expect(plan.missingCapabilities).toEqual(["vision"]);
    expect(plan.routeUnavailable).toBe(false);
  });
});

describe("SR-05 G — SR-04 cancellation compatibility", () => {
  it("does not write route health when the client aborts before output", async () => {
    combo();
    h.fetchMock.mockImplementationOnce(async () => {
      const body = new ReadableStream({ start() {} });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const ctrl = new AbortController();
    const p = runChat({ model: "mycombo", signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 30);
    const res = await p;
    await drain(res);

    expect(res.status).toBe(499);
    expect(h.state.calls).toHaveLength(1);
    expect(h.state.healthFailures).toEqual([]);
    expect(h.state.markCalls).toEqual([]);
  }, 10000);
});

describe("SR-05 H — SR-03 streaming compatibility", () => {
  it("does not mutate route health after the stream is committed", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => brokenSseFixture([roleFrame(), contentFrame("chatcmpl-1", "partial")], new Error("decode failure")))
      .mockImplementationOnce(async () => sseFixture(successFrames("chatcmpl-2", "WRONG")).response);

    const res = await runChat({ model: "mycombo" });
    const text = await drain(res);

    expect(h.state.calls).toHaveLength(1);
    expect(contentOf(text)).toBe("partial");
    expect(text).not.toContain("WRONG");
    expect(terminalCount(text)).toBe(0);
    expect(h.state.healthFailures).toEqual([]); // committed failure is not a route signal
  }, 10000);
});
