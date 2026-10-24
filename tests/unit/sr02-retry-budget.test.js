// SR-02: retry metadata must survive the account → combo hand-off, and the
// bounded error-body read must be bounded in bytes as well as time.
// Drives the real production path (handleChat → handleSingleModelChat →
// handleChatCore → real combo planner + real validateChatComboResponse); only
// the upstream executor/auth/settings edges are mocked.
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => {
  // Short deadline so a stalled body is observed fast; the byte cap keeps its
  // production default on purpose (asserted in the byte-cap tests).
  process.env.ERROR_BODY_READ_TIMEOUT_MS = "150";
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
  const conn = (id, name) => ({ id, connectionId: id, connectionName: name, isActive: true, accessToken: "tok", providerSpecificData: {} });
  return {
    conn,
    fetchMock,
    state: {
      combos: {},
      connections: [conn("conn-1", "Local")],
      beforeModelAttempt: null,
      validateSuccess: null,
      attempts: [],
      calls: [],
      markCalls: [],
    },
  };
});

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor() {
    return {
      noAuth: true,
      async execute({ model, body, stream, credentials, signal }) {
        h.state.attempts.push(model);
        h.state.calls.push({ model, conn: credentials?.connectionId || null, stream, signal });
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
  getProviderCredentials: vi.fn(async (_provider, exclude) => {
    const conns = h.state.connections;
    return conns.find((c) => !exclude?.has(c.connectionId)) || null;
  }),
  markAccountUnavailable: vi.fn(async (_id, status, _error, _provider, _model, resetsAtMs) => {
    h.state.markCalls.push({ id: _id, status, resetsAtMs });
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
    inspectModel: (...a) => h.state.beforeModelAttempt?.(...a) || { skip: false },
    beforeModelAttempt: (...a) => h.state.beforeModelAttempt?.(...a) || { skip: false },
    onModelSuccess: async () => {},
    onModelFailure: async () => {},
    onModelCancelled: async () => {},
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
const { parseUpstreamError, createErrorResult } = await import("../../open-sse/utils/error.js");
const { ERROR_BODY_MAX_BYTES } = await import("../../open-sse/config/runtimeConfig.js");

const enc = (s) => new TextEncoder().encode(s);
const chunk = (delta) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta }] })}\n\n`;
const SSE = [
  chunk({ role: "assistant", content: "" }),
  chunk({ content: "hi" }),
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
  "data: [DONE]\n\n",
];
function sseResponse() {
  let i = 0;
  return new Response(new ReadableStream({ pull(c) { if (i >= SSE.length) return c.close(); c.enqueue(enc(SSE[i++])); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}
function jsonResponse(obj, status, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
}
const rateLimited = (headers = {}, extra = {}) => jsonResponse({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", ...extra } }, 429, headers);
const retryInfo429 = (seconds) => rateLimited({}, { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: `${seconds}s` }] });

function runChat({ model, signal, stream = true } = {}) {
  const req = new Request("http://localhost:21298/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "q" }] }),
    signal,
  });
  return handleChat(req);
}

/** Reset per-test state. `models` defines the combo under the name "mycombo". */
function combo(models = ["gemini/gemini-2.5-pro", "deepseek/deepseek-chat"]) {
  h.state.combos["mycombo"] = models;
  h.state.connections = [h.conn("conn-1", "Local")];
  h.state.beforeModelAttempt = null;
  h.state.validateSuccess = validateChatComboResponse;
  h.state.attempts = [];
  h.state.calls = [];
  h.state.markCalls = [];
  h.fetchMock.mockReset();
}

/** Delay reported by an exhausted response, in whole seconds. */
const retryAfterSeconds = (res) => {
  const raw = res.headers.get("retry-after");
  return raw == null ? null : Number(raw);
};

describe("SR-02 account → combo retry metadata", () => {
  it("429 without Retry-After keeps the status and emits no fabricated hint", async () => {
    combo();
    h.fetchMock.mockImplementationOnce(async () => rateLimited()).mockImplementationOnce(async () => rateLimited());

    const res = await runChat({ model: "mycombo" });
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(retryAfterSeconds(res)).toBeNull();
    expect(body.error.message).toMatch(/exhausted/i);
    expect(h.state.calls.map((c) => c.model)).toEqual(["gemini-2.5-pro", "deepseek-chat"]);
  }, 10000);

  it("propagates a delta-seconds Retry-After from the account chain to the client", async () => {
    combo(["gemini/gemini-2.5-pro"]);
    h.fetchMock.mockImplementationOnce(async () => rateLimited({ "retry-after": "120" }));

    const res = await runChat({ model: "mycombo" });

    expect(res.status).toBe(429);
    // ceil() in unavailableResponse; allow 2s of scheduling slack.
    expect(retryAfterSeconds(res)).toBeGreaterThanOrEqual(118);
    expect(retryAfterSeconds(res)).toBeLessThanOrEqual(120);
    expect(h.state.markCalls[0].resetsAtMs).toBeGreaterThan(Date.now() + 100_000);
  }, 10000);

  it("propagates an HTTP-date Retry-After from the account chain to the client", async () => {
    combo(["gemini/gemini-2.5-pro"]);
    const httpDate = new Date(Date.now() + 90_000).toUTCString();
    h.fetchMock.mockImplementationOnce(async () => rateLimited({ "retry-after": httpDate }));

    const res = await runChat({ model: "mycombo" });

    expect(res.status).toBe(429);
    expect(retryAfterSeconds(res)).toBeGreaterThanOrEqual(88);
    expect(retryAfterSeconds(res)).toBeLessThanOrEqual(90);
  }, 10000);

  it("propagates provider-specific quota reset metadata to the client", async () => {
    combo(["gemini/gemini-2.5-pro"]);
    h.fetchMock.mockImplementationOnce(async () => retryInfo429(1800));

    const res = await runChat({ model: "mycombo" });

    expect(res.status).toBe(429);
    expect(retryAfterSeconds(res)).toBeGreaterThanOrEqual(1798);
    expect(retryAfterSeconds(res)).toBeLessThanOrEqual(1800);
  }, 10000);

  it("does not wait out account reset windows when a healthy candidate exists", async () => {
    combo();
    h.state.connections = [h.conn("conn-1", "A"), h.conn("conn-2", "B")];
    const t0 = Date.now();
    h.fetchMock
      .mockImplementationOnce(async () => rateLimited({ "retry-after": "3600" }))
      .mockImplementationOnce(async () => retryInfo429(1800))
      .mockImplementationOnce(async () => sseResponse());

    const res = await runChat({ model: "mycombo" });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("hi");
    expect(h.state.calls.map((c) => [c.model, c.conn])).toEqual([
      ["gemini-2.5-pro", "conn-1"],
      ["gemini-2.5-pro", "conn-2"],
      ["deepseek-chat", "conn-1"],
    ]);
    expect(Date.now() - t0).toBeLessThan(2000);
  }, 10000);

  it("all candidates unavailable: the earliest reset wins and order is preserved", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => rateLimited({ "retry-after": "600" }))
      .mockImplementationOnce(async () => rateLimited({ "retry-after": "120" }));

    const res = await runChat({ model: "mycombo" });
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(h.state.calls.map((c) => c.model)).toEqual(["gemini-2.5-pro", "deepseek-chat"]);
    expect(retryAfterSeconds(res)).toBeGreaterThanOrEqual(118);
    expect(retryAfterSeconds(res)).toBeLessThanOrEqual(120);
    expect(body.error.message).toMatch(/exhausted|rate/i);
  }, 10000);

  it("ignores malformed or negative retry metadata instead of fabricating a hint", async () => {
    combo();
    h.fetchMock
      .mockImplementationOnce(async () => rateLimited({ "retry-after": "soon" }))
      .mockImplementationOnce(async () => rateLimited({ "retry-after": "-30" }, { retryDelay: "not-a-duration" }));

    const res = await runChat({ model: "mycombo" });

    expect(res.status).toBe(429);
    expect(retryAfterSeconds(res)).toBeNull();
  }, 10000);

  it("solo model: the reset hint survives the account chain in the error body", async () => {
    combo();
    h.state.combos = {}; // not a combo: the account chain owns the response
    h.fetchMock.mockImplementationOnce(async () => rateLimited({ "retry-after": "120" }));

    const res = await runChat({ model: "gemini/gemini-2.5-pro" });
    const body = await res.json();
    const reset = Number(body.error?.metadata?.headers?.["X-RateLimit-Reset"]);

    expect(res.status).toBe(429);
    expect(Number.isFinite(reset)).toBe(true);
    expect(reset).toBeGreaterThan(Date.now() + 100_000);
    expect(reset).toBeLessThanOrEqual(Date.now() + 121_000);
  }, 10000);
});

describe("SR-02 retryable non-429 and chain boundaries", () => {
  it.each([502, 503, 504])("advances the account chain once per account on %i", async (status) => {
    combo();
    h.state.connections = [h.conn("conn-1", "A"), h.conn("conn-2", "B")];
    h.fetchMock
      .mockImplementationOnce(async () => jsonResponse({ error: { message: `upstream ${status}` } }, status))
      .mockImplementationOnce(async () => jsonResponse({ error: { message: `upstream ${status}` } }, status))
      .mockImplementationOnce(async () => sseResponse());

    const res = await runChat({ model: "mycombo" });

    expect(res.status).toBe(200);
    expect(h.state.calls.map((c) => [c.model, c.conn])).toEqual([
      ["gemini-2.5-pro", "conn-1"],
      ["gemini-2.5-pro", "conn-2"],
      ["deepseek-chat", "conn-1"],
    ]);
  }, 10000);

  it("a non-chainable 400 stops the chain without retry amplification", async () => {
    combo();
    h.state.connections = [h.conn("conn-1", "A"), h.conn("conn-2", "B")];
    h.fetchMock.mockImplementationOnce(async () => jsonResponse({ error: { message: "invalid request body" } }, 400));

    const res = await runChat({ model: "mycombo" });

    expect(res.status).toBe(400);
    expect(h.state.calls.map((c) => c.conn)).toEqual(["conn-1"]);
    expect(h.state.markCalls.map((c) => c.status)).toEqual([400]);
  }, 10000);

  it("bounds a stalled error body per candidate instead of per request", async () => {
    combo();
    const hanging = () => new Response(new ReadableStream({ start() {} }), { status: 429, headers: { "content-type": "application/json" } });
    h.fetchMock.mockImplementation(async () => hanging());

    const t0 = Date.now();
    const res = await runChat({ model: "mycombo" });
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(429);
    expect(h.state.calls).toHaveLength(2);
    // Two candidates x the 150 ms test deadline; nowhere near a 5 s default.
    expect(elapsed).toBeLessThan(1500);
  }, 10000);

  it("a client abort during error-body reading stops the chain promptly", async () => {
    combo();
    h.state.connections = [h.conn("conn-1", "A"), h.conn("conn-2", "B")];
    h.fetchMock.mockImplementation(async () => new Response(new ReadableStream({ start() {} }), { status: 429, headers: { "content-type": "application/json" } }));

    const ctrl = new AbortController();
    const t0 = Date.now();
    const p = runChat({ model: "mycombo", signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);

    const res = await p;
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(1000);
    // The abort cut the reader short; the combo does not dispatch another
    // candidate after the client left.
    expect(h.state.calls.map((c) => c.conn)).toEqual(["conn-1"]);
    await res.text().catch(() => "");
  }, 10000);
});

// ---------------------------------------------------------------------------
// Byte-bounded error-body reader (no network, no provider calls)
// ---------------------------------------------------------------------------

/** A response body that reports reader cancellation and pull counts. */
function trackedBody({ start = null, pull = null } = {}) {
  const tracker = { cancelled: 0, pulls: 0 };
  const stream = new ReadableStream({
    start(c) { tracker.started = true; start?.(c, tracker); },
    pull(c) { tracker.pulls += 1; pull?.(c, tracker); },
    cancel() { tracker.cancelled += 1; },
  });
  return { response: new Response(stream, { status: 429, headers: { "content-type": "application/json" } }), tracker };
}

describe("SR-02 bounded error-body memory", () => {
  it("caps a fast oversized body and cancels the reader", async () => {
    const oversized = "a".repeat(ERROR_BODY_MAX_BYTES + 5000) + "TAIL";
    const { response, tracker } = trackedBody({ start(c) { c.enqueue(enc(oversized)); } });

    const t0 = Date.now();
    const { statusCode, message } = await parseUpstreamError(response, null, null);
    const elapsed = Date.now() - t0;

    expect(statusCode).toBe(429);
    expect(message.length).toBeLessThanOrEqual(ERROR_BODY_MAX_BYTES);
    expect(message).not.toContain("TAIL");
    expect(elapsed).toBeLessThan(1000);
    expect(tracker.cancelled).toBe(1);
  }, 10000);

  it("stops at the cap across many rapid chunks", async () => {
    const block = "b".repeat(1024);
    const { response, tracker } = trackedBody({ pull(c) { c.enqueue(enc(block)); } });

    const { statusCode, message } = await parseUpstreamError(response, null, null);

    expect(statusCode).toBe(429);
    expect(message.length).toBe(ERROR_BODY_MAX_BYTES);
    // One chunk at the cap boundary plus the stream's prefetch read.
    expect(tracker.pulls).toBeLessThanOrEqual(ERROR_BODY_MAX_BYTES / 1024 + 2);
    expect(tracker.cancelled).toBe(1);
  }, 10000);

  it("drops a split UTF-8 sequence at the cap instead of emitting a broken character", async () => {
    const prefix = "a".repeat(ERROR_BODY_MAX_BYTES - 1);
    const { response, tracker } = trackedBody({ start(c) { c.enqueue(enc(`${prefix}\u20acTAIL`)); } });

    const { statusCode, message } = await parseUpstreamError(response, null, null);

    expect(statusCode).toBe(429);
    expect(message).toBe(prefix);
    expect(message).not.toContain("\uFFFD");
    expect(tracker.cancelled).toBe(1);
  }, 10000);

  it("a stalled body hits the deadline and still preserves the upstream status", async () => {
    const { response, tracker } = trackedBody({ start() {} });

    const t0 = Date.now();
    const { statusCode } = await parseUpstreamError(response, null, null);

    expect(statusCode).toBe(429);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(tracker.cancelled).toBe(1);
  }, 10000);

  it("a locked or consumed body preserves the status without throwing", async () => {
    const consumed = new Response(JSON.stringify({ error: { message: "gone" } }), { status: 429 });
    await consumed.text();

    const { statusCode, message } = await parseUpstreamError(consumed, null, null);

    expect(statusCode).toBe(429);
    expect(typeof message).toBe("string");
  }, 10000);

  it("a truncated JSON body keeps the text and the upstream status", async () => {
    const { response } = trackedBody({ start(c) { c.enqueue(enc('{"error":{"message":"boom"')); c.close(); } });

    const { statusCode, message } = await parseUpstreamError(response, null, null);

    expect(statusCode).toBe(429);
    expect(message).toContain("boom");
  }, 10000);

  it("a pre-aborted client signal returns the status promptly", async () => {
    const { response, tracker } = trackedBody({ start() {} });
    const ctrl = new AbortController();
    ctrl.abort();

    const t0 = Date.now();
    const { statusCode } = await parseUpstreamError(response, null, ctrl.signal);

    expect(statusCode).toBe(429);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(tracker.cancelled).toBe(1);
  }, 10000);
});

// ---------------------------------------------------------------------------
// PR #24 review finding P2: reset metadata must never advertise a bogus
// deadline. `Number(null) === 0` and `Number.isFinite(0)` previously let a
// missing/expired reset through as X-RateLimit-Reset "null" / "0".
// ---------------------------------------------------------------------------

describe("RC-02 review: reset metadata validity", () => {
  const resetHeader = async (resetsAtMs) => {
    const body = await createErrorResult(429, "rate limited", resetsAtMs).response.json();
    return body.error?.metadata?.headers?.["X-RateLimit-Reset"];
  };

  it.each([
    ["missing (null)", null],
    ["missing (undefined)", undefined],
    ["zero", 0],
    ["negative", -1],
    ["not a number", "not-a-deadline"],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["expired", Date.now() - 1_000],
  ])("omits the reset hint for %s", async (_label, value) => {
    expect(await resetHeader(value)).toBeUndefined();
  });

  it("preserves a valid future reset timestamp exactly", async () => {
    const future = Date.now() + 120_000;
    expect(await resetHeader(future)).toBe(String(future));
  });

  it("does not advertise a reset when the account chain has none", async () => {
    combo();
    h.state.combos = {};
    h.fetchMock.mockImplementationOnce(async () => rateLimited());

    const res = await runChat({ model: "gemini/gemini-2.5-pro" });
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error?.metadata?.headers?.["X-RateLimit-Reset"]).toBeUndefined();
  }, 10000);

  it("advertises the earliest valid reset across exhausted accounts", async () => {
    combo();
    h.state.combos = {};
    h.state.connections = [h.conn("conn-1", "A"), h.conn("conn-2", "B")];
    h.fetchMock
      .mockImplementationOnce(async () => rateLimited({ "retry-after": "600" }))
      .mockImplementationOnce(async () => rateLimited({ "retry-after": "120" }));

    const res = await runChat({ model: "gemini/gemini-2.5-pro" });
    const body = await res.json();
    const reset = Number(body.error?.metadata?.headers?.["X-RateLimit-Reset"]);

    expect(res.status).toBe(429);
    expect(h.state.calls.map((c) => c.conn)).toEqual(["conn-1", "conn-2"]);
    expect(Number.isFinite(reset)).toBe(true);
    expect(reset).toBeGreaterThan(Date.now() + 100_000);
    expect(reset).toBeLessThanOrEqual(Date.now() + 121_000);
  }, 10000);
});
