/**
 * SR-06 — sanitized attempt-level routing diagnostics.
 *
 * Contract under test (opt-in `SHOWDAR_ROUTER_LATENCY_TRACE=1`):
 *  - stable schema: request outcome, configured candidates, per-attempt
 *    dispatch/failure/winner facts, bounded timings;
 *  - enum-only failure classification, bounded labels, no raw provider text,
 *    prompts, headers, credentials or client identifiers;
 *  - cancellation vs timeout vs provider failure stay distinguishable;
 *  - tracing failures never interrupt the request and disabled tracing is inert.
 *
 * Harness: real handleChat → chatCore → (mocked) executor → global fetch
 * (patched by proxyFetch, so dispatch marks are real). Combo/fusion/planner are
 * the real implementations; only the route-health edge is stubbed.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const h = vi.hoisted(() => {
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
  const conn = (id) => ({
    id,
    connectionId: id,
    connectionName: id,
    isActive: true,
    accessToken: "tok",
    providerSpecificData: {},
  });
  return {
    fetchMock,
    conn,
    state: {
      calls: [],
      combos: {},
      comboStrategies: {},
      connections: [conn("conn-1")],
      respond: null,
      beforeModelAttempt: null,
      inspectModel: null,
      validateSuccess: null,
    },
  };
});

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor() {
    return {
      noAuth: true,
      async execute({ model, body, signal }) {
        const res = await globalThis.fetch("https://upstream.example/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, model }),
          signal,
        });
        return {
          response: res,
          url: "https://upstream.example/v1/chat/completions",
          headers: {},
          transformedBody: body,
        };
      },
    };
  },
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest() {},
    logRawRequest() {},
    logTargetRequest() {},
    logProviderResponse() {},
    logConvertedResponse() {},
    logOpenAIRequest() {},
    logConvertedChunk() {},
    appendOpenAIChunk() {},
    logError() {},
    logResponse() {},
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async (_provider, exclude) =>
    h.state.connections.find((c) => !exclude?.has(c.connectionId)) || null
  ),
  markAccountUnavailable: vi.fn(async (_id, status) => ({
    shouldFallback: status === 429 || status >= 500,
    cooldownMs: 0,
  })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: (req) =>
    req?.headers?.get?.("authorization")?.startsWith("Bearer ")
      ? req.headers.get("authorization").slice(7)
      : null,
  isValidApiKey: async () => true,
}));

vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(async () => 0),
  clearAntigravityStrikes: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({
    requireApiKey: false,
    ccFilterNaming: false,
    rtkEnabled: false,
    headroomEnabled: false,
    headroomCompressUserMessages: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    providerThinking: {},
    comboStrategies: h.state.comboStrategies,
    comboStrategy: "fallback",
    comboStickyRoundRobinLimit: 0,
  })),
}));

vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async (modelStr) => {
    const idx = String(modelStr).indexOf("/");
    if (idx <= 0) return { provider: null, model: null };
    return { provider: modelStr.slice(0, idx), model: modelStr.slice(idx + 1) };
  }),
  getComboModels: vi.fn(async (name) => h.state.combos[name] || null),
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(async () => {}),
  checkAndRefreshToken: vi.fn(async (_provider, creds) => creds),
}));

vi.mock("@/sse/services/comboHealthHooks.js", () => ({
  createChatComboHealthHooks: () => ({
    inspectModel: (...args) => h.state.inspectModel(...args),
    beforeModelAttempt: (...args) => h.state.beforeModelAttempt(...args),
    onModelSuccess: async () => {},
    onModelFailure: async () => {},
    onModelCancelled: async () => {},
    get validateSuccess() { return h.state.validateSuccess; },
  }),
}));

vi.mock("@/sse/utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    line: vi.fn(),
    errorLine: vi.fn(),
    maskKey: () => "****",
  };
});

vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost:1" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn(async () => null) }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("../../open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((fn) => fn),
  getActiveAdapterStrategy: vi.fn(() => "fallback"),
}));
vi.mock("../../open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn(async () => null),
}));

const { handleChat } = await import("@/sse/handlers/chat.js");
const { resetComboRoundRobin } = await import("../../open-sse/services/comboRoundRobin.js");
const {
  createLatencyTrace,
  runWithLatencyTrace,
  classifyFailure,
} = await import("../../open-sse/utils/latencyTrace.js");
const { handleFusionChat } = await import("../../open-sse/services/combo.js");
const { planComboCandidates } = await import("../../open-sse/services/comboPlanner.js");

const PREFIX = "[showdar-latency] ";
const RAW_LINES = [];

function takeLines() {
  return RAW_LINES.splice(0, RAW_LINES.length).map((l) => {
    expect(l.startsWith(PREFIX)).toBe(true);
    return JSON.parse(l.slice(PREFIX.length));
  });
}
function oneLine() {
  const lines = takeLines();
  expect(lines).toHaveLength(1);
  return lines[0];
}

beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation((...args) => {
    const first = args[0];
    if (typeof first === "string" && first.startsWith(PREFIX)) RAW_LINES.push(first);
  });
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (s) => new TextEncoder().encode(s);
const PROMPT = "SR06_PROMPT_CANARY_q7";
const key = (n) => ["sk", n].join("-");

const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "upstream-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const ROLE = chunk({ role: "assistant", content: "" });
const CONTENT = chunk({ content: "hello" });
const FINISH = chunk({}, "stop");
const DONE = "data: [DONE]\n\n";
const SSE_PARTS = [ROLE, CONTENT, FINISH, DONE];

const completion = (content) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "upstream-model",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

function byteStream(parts, { firstDelayMs = 0, gapMs = 0 } = {}) {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= parts.length) return controller.close();
      if (i === 0 && firstDelayMs) await delay(firstDelayMs);
      else if (i > 0 && gapMs) await delay(gapMs);
      controller.enqueue(enc(parts[i++]));
    },
  });
}
const sseResponse = (parts = SSE_PARTS, opts) =>
  new Response(byteStream(parts, opts), { status: 200, headers: { "content-type": "text/event-stream" } });
const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

async function defaultRespond(body) {
  await delay(3);
  return body.stream ? sseResponse(SSE_PARTS, { gapMs: 2 }) : jsonResponse(completion("ok"));
}

function runChat({
  model = "openai/model-a",
  apiKey = key(1),
  headers = {},
  body = {},
  stream = true,
  url = "http://localhost:21298/v1/chat/completions",
} = {}) {
  const req = new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    },
    body: JSON.stringify({
      model,
      stream,
      messages: [{ role: "user", content: PROMPT }],
      ...body,
    }),
  });
  return handleChat(req);
}

beforeEach(() => {
  vi.stubEnv("SHOWDAR_ROUTER_LATENCY_TRACE", "1");
  resetComboRoundRobin();
  RAW_LINES.length = 0;
  h.state.calls = [];
  h.state.combos = {};
  h.state.comboStrategies = {};
  h.state.connections = [h.conn("conn-1")];
  h.state.beforeModelAttempt = async () => ({ skip: false });
  h.state.inspectModel = async () => ({ skip: false });
  h.state.validateSuccess = null;
  h.state.respond = defaultRespond;
  h.fetchMock.mockReset();
  h.fetchMock.mockImplementation(async (_url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    h.state.calls.push({ model: String(body.model ?? ""), stream: !!body.stream });
    return h.state.respond(body);
  });
});

// ---- schema inventory ------------------------------------------------------

const PAYLOAD_KEYS = ["attempts", "candidates", "combo", "endpoint", "kind", "marks", "stats", "v", "winner"];
const ATTEMPT_KEYS = [
  "authRefresh", "dispatchedMs", "endMs", "firstByteMs", "meaningfulMs", "model",
  "networkAttempt", "ordinal", "probe", "reason", "result", "retryDispatches",
  "startMs", "status", "upstreamFirstByteMs", "upstreamMeaningfulMs",
];
const CANDIDATE_KEYS = ["eligible", "healthSkip", "healthSkipReason", "model", "networkAttempts", "ordinal"];
const MARK_KEYS = ["t0", "t1", "t2", "t3", "t3m", "t4", "t4m", "t5"];
const STATS_KEYS = [
  "clientTtftMs", "failedAttemptWallMs", "fallbackAttempts", "preDispatchMs",
  "proxyFirstByteDelayMs", "selectionMs", "timeBeforeWinnerMs", "totalMs",
  "upstreamFirstMeaningfulMs", "upstreamTtfbMs", "winnerUpstreamTtftMs",
];
const RESULTS = new Set(["success", "failure", "cancelled"]);
const REASONS = new Set([
  "timeout", "rate_limited", "auth", "upstream_4xx", "upstream_5xx",
  "network_error", "cancelled", "invalid_response", "unknown",
]);
const KINDS = new Set(["completed", "failed", "cancelled"]);

function assertSanitizedEnvelope(p) {
  expect(Object.keys(p).sort()).toEqual([...PAYLOAD_KEYS].sort());
  expect(Object.keys(p.marks).sort()).toEqual([...MARK_KEYS].sort());
  expect(Object.keys(p.stats).sort()).toEqual([...STATS_KEYS].sort());
  expect(KINDS.has(p.kind)).toBe(true);
  for (const a of p.attempts) {
    expect(Object.keys(a).sort()).toEqual([...ATTEMPT_KEYS].sort());
    expect(RESULTS.has(a.result)).toBe(true);
    if (a.reason != null) expect(REASONS.has(a.reason)).toBe(true);
    expect(typeof a.probe).toBe("boolean");
  }
  for (const c of p.candidates) {
    expect(Object.keys(c).sort()).toEqual([...CANDIDATE_KEYS].sort());
    expect(typeof c.eligible).toBe("boolean");
    expect(typeof c.healthSkip).toBe("boolean");
  }
  for (const v of Object.values(p.marks)) {
    expect(v == null || (Number.isFinite(v) && v >= 0 && v <= 120_000)).toBe(true);
  }
}

// ---- A. normal routing -----------------------------------------------------

describe("SR-06 A — normal routing trace", () => {
  it("emits the full bounded schema for a clean solo streaming request", async () => {
    const res = await runChat();
    const text = await res.text();
    const p = oneLine();

    expect(res.status).toBe(200);
    expect(text).toContain("hello");
    assertSanitizedEnvelope(p);
    expect(p.v).toBe(1);
    expect(p.kind).toBe("completed");
    expect(p.endpoint).toBe("/v1/chat/completions");
    expect(p.combo).toBeNull();
    expect(p.attempts).toHaveLength(1);
    expect(p.attempts[0]).toMatchObject({ ordinal: 0, model: "openai/model-a", result: "success", probe: false });
    expect(p.winner).toEqual({ ordinal: 0, model: "openai/model-a", type: "CLEAN_WINNER" });
    expect(p.stats.fallbackAttempts).toBe(0);
    expect(p.stats.totalMs).not.toBeNull();
  });
});

// ---- B. Gemini-style 429 fallback -----------------------------------------

describe("SR-06 B — 429 fallback trace", () => {
  it("explains dispatch, rate-limit classification, fallback and winner without response text", async () => {
    h.state.combos["coding-fast"] = ["google/gemini-2.5-flash", "openai/model-b"];
    h.state.respond = async (body) => {
      if (String(body.model).includes("gemini")) {
        await delay(5);
        return jsonResponse({ error: { message: "SECRET_GEMINI_429_BODY quota exceeded" } }, 429);
      }
      await delay(3);
      return sseResponse(SSE_PARTS, { gapMs: 2 });
    };

    const res = await runChat({ model: "coding-fast" });
    const text = await res.text();
    const p = oneLine();

    expect(res.status).toBe(200);
    expect(text).not.toContain("SECRET_GEMINI_429_BODY");
    expect(p.combo).toEqual({ name: "coding-fast", strategy: "fallback" });
    expect(p.attempts).toHaveLength(2);
    expect(p.attempts[0]).toMatchObject({
      ordinal: 0,
      model: "google/gemini-2.5-flash",
      result: "failure",
      status: 429,
      reason: "rate_limited",
    });
    expect(p.attempts[1]).toMatchObject({ ordinal: 1, model: "openai/model-b", result: "success" });
    expect(p.winner).toEqual({ ordinal: 1, model: "openai/model-b", type: "FALLBACK_WINNER" });
    expect(p.stats.fallbackAttempts).toBe(1);
    // Cooldown metadata never carries provider text into the trace.
    expect(JSON.stringify(p)).not.toMatch(/quota exceeded/i);
  });
});

// ---- C. account exhaustion -------------------------------------------------

describe("SR-06 C — account exhaustion", () => {
  it("records one attempt per dispatched account and a failed terminal", async () => {
    h.state.connections = [h.conn("conn-1"), h.conn("conn-2")];
    h.state.respond = async () => jsonResponse({ error: { message: "rate limit exceeded" } }, 429);

    const res = await runChat({ model: "deepseek/deepseek-chat" });
    const p = oneLine();

    expect(res.status).toBe(429);
    expect(h.state.calls).toHaveLength(2);
    expect(p.kind).toBe("failed");
    expect(p.winner).toBeNull();
    expect(p.attempts).toHaveLength(2);
    expect(p.attempts.every((a) => a.result === "failure" && a.status === 429 && a.reason === "rate_limited")).toBe(true);
    expect(p.candidates).toHaveLength(1);
    expect(p.candidates[0].networkAttempts).toBe(2);
    expect(p.stats.fallbackAttempts).toBeNull(); // no winner → no fallback accounting
  });

  it("falls back to the next account and reports a fallback winner", async () => {
    h.state.connections = [h.conn("conn-1"), h.conn("conn-2")];
    h.state.respond = async (body, url) => {
      const m = String(body.model);
      if (h.state.calls.filter((c) => c.model === m).length === 1) {
        return jsonResponse({ error: { message: "rate limit exceeded" } }, 429);
      }
      return sseResponse(SSE_PARTS, { gapMs: 2 });
    };

    const res = await runChat({ model: "deepseek/deepseek-chat" });
    await res.text();
    const p = oneLine();

    expect(res.status).toBe(200);
    expect(p.attempts).toHaveLength(2);
    expect(p.attempts[0].reason).toBe("rate_limited");
    expect(p.attempts[1].result).toBe("success");
    expect(p.winner.type).toBe("FALLBACK_WINNER");
  });
});

// ---- D. timeout vs cancellation -------------------------------------------

describe("SR-06 D — timeout versus client cancellation", () => {
  it("classifies an upstream connect timeout as failed/timeout", async () => {
    h.state.respond = async () => {
      throw Object.assign(new Error("connect ETIMEDOUT 10.0.0.9:443"), { code: "ETIMEDOUT" });
    };

    const res = await runChat();
    const p = oneLine();

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(p.kind).toBe("failed");
    expect(p.attempts).toHaveLength(1);
    expect(p.attempts[0]).toMatchObject({ result: "failure", reason: "timeout" });
    expect(p.winner).toBeNull();
  });

  it("reports a client abort as cancelled, never as a provider failure", async () => {
    h.state.respond = async () =>
      new Response(
        new ReadableStream({
          start(controller) { controller.enqueue(enc(ROLE)); /* hang */ },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );

    const res = await runChat();
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel("client-left");
    await delay(60);
    const p = oneLine();

    expect(p.kind).toBe("cancelled");
    expect(p.attempts).toHaveLength(1);
    expect(p.attempts.some((a) => a.result === "failure")).toBe(false);
    expect(p.attempts[0].result).toBe("success"); // headers accepted; the client left mid-stream
    expect(p.attempts[0].reason).not.toBe("timeout");
    expect(classifyFailure({ status: 499 })).toBe("cancelled");
    expect(classifyFailure({ status: 502, errorText: "connect timeout" })).toBe("timeout");
  });
});

// ---- E. health decisions ---------------------------------------------------

describe("SR-06 E — health skip, half-open probe and ineligibility", () => {
  it("records a cooldown skip with a safe reason enum and no attempt", async () => {
    h.state.combos["coding-fast"] = ["openai/model-a", "openai/model-b"];
    h.state.beforeModelAttempt = async (model) =>
      String(model).includes("model-a")
        ? { skip: true, reason: "transient_rate_limit", nextProbeAt: new Date(Date.now() + 30_000).toISOString() }
        : { skip: false };

    const res = await runChat({ model: "coding-fast" });
    await res.text();
    const p = oneLine();

    expect(h.state.calls).toHaveLength(1);
    expect(p.attempts).toHaveLength(1);
    const skipped = p.candidates.find((c) => c.model === "openai/model-a");
    expect(skipped.healthSkip).toBe(true);
    expect(skipped.healthSkipReason).toBe("transient_rate_limit");
    expect(skipped.networkAttempts).toBe(0);
    expect(p.winner.type).toBe("CLEAN_WINNER");
  });

  it("marks a granted half-open probe on the attempt", async () => {
    h.state.combos["coding-fast"] = ["openai/model-a", "openai/model-b"];
    h.state.beforeModelAttempt = async (model) =>
      String(model).includes("model-a") ? { skip: false, probe: true } : { skip: false };

    const res = await runChat({ model: "coding-fast" });
    await res.text();
    const p = oneLine();

    expect(p.attempts).toHaveLength(1);
    expect(p.attempts[0]).toMatchObject({ model: "openai/model-a", probe: true });
    expect(p.winner.type).toBe("CLEAN_WINNER");
  });

  it("records capability-ineligible candidates without dispatching them", async () => {
    const trace = createLatencyTrace({ endpoint: "/unit" });
    const plan = await runWithLatencyTrace(trace, () =>
      planComboCandidates({
        models: ["deepseek/deepseek-chat", "openai/gpt-4o"],
        requiredCapabilities: new Set(["vision"]),
        getCapabilities: (provider) => (provider === "openai" ? { vision: true } : {}),
        latencyTrace: trace,
      })
    );
    trace.finalize("completed");
    const p = oneLine();

    expect(plan.models).toEqual(["openai/gpt-4o"]);
    const ineligible = p.candidates.find((c) => c.model === "deepseek/deepseek-chat");
    expect(ineligible).toMatchObject({ eligible: false, healthSkip: false, networkAttempts: 0 });
    expect(p.candidates.find((c) => c.model === "openai/gpt-4o").eligible).toBe(true);
  });
});

// ---- F. streaming commitment ----------------------------------------------

describe("SR-06 F — streaming commitment", () => {
  it("records a pre-output fallback as completed with one winner", async () => {
    h.state.combos["coding-fast"] = ["openai/model-a", "openai/model-b"];
    h.state.respond = async (body) => {
      if (String(body.model).includes("model-a")) {
        return jsonResponse({ error: { message: "bad gateway" } }, 502);
      }
      return sseResponse(SSE_PARTS, { gapMs: 2 });
    };

    const res = await runChat({ model: "coding-fast" });
    const text = await res.text();
    const p = oneLine();

    expect(res.status).toBe(200);
    expect(text).toContain("hello");
    expect(p.kind).toBe("completed");
    expect(p.attempts).toHaveLength(2);
    expect(p.winner).toMatchObject({ model: "openai/model-b", type: "FALLBACK_WINNER" });
    expect(p.marks.t4).not.toBeNull();
  });

  it("records a post-commit failure as failed with no second attempt", async () => {
    let i = 0;
    h.state.respond = async () =>
      new Response(
        new ReadableStream({
          async pull(controller) {
            if (i < 2) return controller.enqueue(enc(SSE_PARTS[i++]));
            controller.error(new Error("upstream died after commit"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );

    const res = await runChat();
    await res.text().catch(() => "");
    const p = oneLine();

    expect(p.kind).toBe("failed");
    expect(p.attempts).toHaveLength(1);
    expect(h.state.calls).toHaveLength(1);
  });
});

// ---- G. fusion -------------------------------------------------------------

describe("SR-06 G — fusion diagnostics", () => {
  it("records panel dispatch, partial failure and judge without panel content", async () => {
    h.state.combos["fusion-combo"] = ["openai/model-a", "openai/model-b", "openai/model-c"];
    h.state.comboStrategies["fusion-combo"] = { fallbackStrategy: "fusion", judgeModel: "openai/model-judge" };
    h.state.respond = async (body) => {
      const m = String(body.model);
      const answer = "PANEL_CONTENT_CANARY_" + m;
      if (m.includes("model-a")) return jsonResponse({ error: { message: answer } }, 503);
      return sseResponse([ROLE, chunk({ content: answer }), FINISH, DONE], { gapMs: 2 });
    };

    const res = await runChat({ model: "fusion-combo", stream: false });
    const text = await res.text();
    const p = oneLine();

    expect(res.status).toBe(200);
    expect(p.kind).toBe("completed");
    expect(p.combo).toEqual({ name: "fusion-combo", strategy: "fusion" });
    expect(p.attempts.length).toBeGreaterThanOrEqual(4); // 3 panels + judge
    expect(p.attempts.some((a) => a.result === "failure")).toBe(true);
    expect(JSON.stringify(p)).not.toContain("PANEL_CONTENT_CANARY");
    expect(text).not.toContain("PANEL_CONTENT_CANARY_model-a"); // failed panel text never surfaces
  });

  it("marks a cancelled losing panel without leaking its output", async () => {
    const trace = createLatencyTrace({ endpoint: "/v1/chat/completions" });
    const res = await runWithLatencyTrace(trace, () =>
      handleFusionChat({
        body: { messages: [{ role: "user", content: PROMPT }], stream: false },
        models: ["openai/model-a", "openai/model-b", "openai/model-c"],
        comboName: "fusion-straggler",
        judgeModel: "openai/model-judge",
        tuning: { minPanel: 2, stragglerGraceMs: 30, panelHardTimeoutMs: 3000 },
        log: { info() {}, warn() {}, debug() {} },
        handleSingleModel: (_body, model, _panel, options = {}) => {
          if (String(model).includes("model-c")) {
            return new Promise((_, reject) => {
              options.signal?.addEventListener("abort", () =>
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
              );
            });
          }
          return Promise.resolve(jsonResponse(completion("LATE_PANEL_CANARY " + model)));
        },
      })
    );
    trace.finalize("completed");
    const p = oneLine();

    expect(res.status).toBe(200);
    const straggler = p.attempts.find((a) => a.model === "openai/model-c");
    expect(straggler.result).toBe("cancelled");
    expect(JSON.stringify(p)).not.toContain("LATE_PANEL_CANARY");
    expect(p.kind).toBe("completed");
  });
});

// ---- H. disabled tracing ---------------------------------------------------

describe("SR-06 H — disabled diagnostics", () => {
  it("emits nothing and leaves routing identical when the flag is off", async () => {
    h.state.combos["coding-fast"] = ["openai/model-a", "openai/model-b"];
    h.state.respond = async (body) => {
      if (String(body.model).includes("model-a")) {
        return jsonResponse({ error: { message: "rate limit exceeded" } }, 429);
      }
      return sseResponse(SSE_PARTS, { gapMs: 2 });
    };
    vi.stubEnv("SHOWDAR_ROUTER_LATENCY_TRACE", "0");

    const res = await runChat({ model: "coding-fast" });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("hello");
    expect(h.state.calls).toHaveLength(2);
    expect(takeLines()).toHaveLength(0);
    expect(createLatencyTrace({ endpoint: "/x" })).toBeNull();
  });
});

// ---- privacy and robustness ----------------------------------------------

describe("SR-06 privacy — canary sweep", () => {
  it("never emits credentials, prompts, tool arguments, cookies, bodies, paths or addresses", async () => {
    const canaries = {
      apiKey: "sk-CANARY-API-KEY-9911",
      cookie: "session=CANARY-COOKIE-9911",
      requestId: "msg_CANARY_REQUEST_ID_9911",
      toolArg: "CANARY_TOOL_ARGUMENT_9911",
      providerBody: "CANARY_PROVIDER_BODY_9911",
      path: "/Users/canary/private/secret.txt",
      ip: "10.77.88.99",
      bearer: "Bearer CANARY-BEARER-9911",
    };
    h.state.respond = async () =>
      jsonResponse(
        {
          error: {
            message: `${canaries.providerBody} ${canaries.path} ${canaries.ip}\nsecond line ${canaries.toolArg}`,
          },
        },
        500
      );

    const res = await runChat({
      model: "openai/model-a",
      apiKey: canaries.apiKey,
      headers: {
        cookie: canaries.cookie,
        "x-request-id": canaries.requestId,
        "x-api-key": canaries.toolArg,
      },
      body: {
        tools: [{ type: "function", function: { name: "t", arguments: JSON.stringify({ q: canaries.toolArg }) } }],
        metadata: { user_id: canaries.requestId },
      },
      url: `http://localhost:21298/v1/chat/completions?api_key=${canaries.apiKey}&token=${canaries.toolArg}`,
    });
    await res.text();
    const p = oneLine();
    const raw = JSON.stringify(p);

    for (const [name, value] of Object.entries(canaries)) {
      if (name === "bearer") continue;
      expect(raw, `leaked ${name}`).not.toContain(value);
    }
    expect(raw).not.toContain(PROMPT);
    expect(raw).not.toContain("Bearer");
    expect(p.endpoint).toBe("/v1/chat/completions");
    expect(p.endpoint).not.toContain("api_key");
    assertSanitizedEnvelope(p);
  });

  it("bounds client-controlled labels so one request cannot emit an unbounded line", async () => {
    const longModel = "openai/" + "m".repeat(5000);
    const res = await runChat({ model: longModel });
    await res.text();
    const line = RAW_LINES[0];

    expect(line.length).toBeLessThan(4000);
    const p = oneLine();
    const emitted = p.attempts[0].model;
    expect(emitted.length).toBeLessThanOrEqual(121);
    expect(emitted.startsWith("openai/")).toBe(true);
  });

  it("keeps the response intact when the trace sink throws", async () => {
    console.error.mockImplementationOnce(() => {
      throw new Error("sink down");
    });

    const res = await runChat();
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("hello");
    expect(takeLines()).toHaveLength(0);
  });
});
