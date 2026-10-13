/**
 * Phase D1 — request-local latency observability (SHOWDAR_ROUTER_LATENCY_TRACE=1).
 *
 * 16 scenarios:
 *  1. Flag off → zero emissions, response bytes identical to flag-on run
 *  2. Solo streaming → full t0..t5 marks + CLEAN_WINNER
 *  3. t3 measures first upstream BODY byte (not response headers)
 *  4. t3m = first meaningful upstream token (role-only chunk does not count)
 *  5. t4/t4m downstream marks (t4 >= t3, t4m follows the meaningful chunk)
 *  6. Combo health-skip candidate: no fetch, no networkAttempt, CLEAN winner
 *  7. 503 → success fallback: FALLBACK_WINNER + wall-time stats == unionMs
 *  8. ETIMEDOUT → classified "timeout", no fabricated upstream first byte
 *  9. Partial-stream error → kind=failed, t3 present, t5 >= t3
 * 10. Client reader cancel → kind=cancelled, exactly one emission
 * 11. Concurrent requests → disjoint payloads (ALS isolation)
 * 12. Exactly one emission per request (+ finalize-twice unit)
 * 13. networkAttempts excludes health skips; retryDispatches field present
 * 14. No secrets/prompts/ids/raw error text in the payload
 * 15. Non-streaming → t3/t4/clientTtftMs null, no fabricated TTFT
 * 16. Fusion 4-panel gated barrier: 2 fail + 2 succeed → judge, failedAttempt
 *     wall time == union of failed spans and strictly < their sum
 * 17. Production validator rejects attempt 1's empty 200 SSE → fallback must
 *     NOT emit early: one emission, attempt 2 recorded as winner
 * 18. Scanner edges: whitespace-only delta not meaningful, CRLF, split lines,
 *     malformed JSON fail-open, buffer cap release
 *
 * Harness: real handleChat → chatCore → (mocked) executor → globalThis.fetch
 * (patched by proxyFetch → proxyAwareFetch, so dispatch marks t2 for real).
 * Combo/fusion/planner/round-robin are the REAL implementations.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const h = vi.hoisted(() => {
  const fetchMock = vi.fn();
  // proxyFetch captures globalThis.fetch at module load — must be our mock before any import.
  globalThis.fetch = fetchMock;
  return {
    fetchMock,
    state: {
      calls: [],
      combos: {},
      comboStrategies: {},
      respond: null,
      beforeModelAttempt: null,
      inspectModel: null,
      validateSuccess: null,
    },
  };
});

// Mocked executor: the real dispatch path — it calls globalThis.fetch, which is
// patched to proxyAwareFetch, so noteUpstreamDispatch() runs for real (t2).
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor(provider) {
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
  getProviderCredentials: vi.fn(async () => ({
    id: "conn-1",
    connectionId: "conn-1",
    connectionName: "Local",
    isActive: true,
    accessToken: "tok",
    providerSpecificData: {},
  })),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false, cooldownMs: 0 })),
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

// Real combo/fusion/planner logic; only the route-health edge is mocked.
// validateSuccess stays null by default (as before); scenario 17 injects the
// REAL production validator through h.state.validateSuccess.
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

// Identity: capacity-adapter must not reorder/drop the fake combo models.
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
const { classifyFailure, unionMs, createLatencyTrace, createMeaningfulScanner } = await import(
  "../../open-sse/utils/latencyTrace.js"
);
const { validateChatComboResponse } = await import(
  "../../open-sse/services/chatComboResponseValidator.js"
);

// ---- emission capture ------------------------------------------------------

const PREFIX = "[showdar-latency] ";
const RAW_LINES = [];

function takeLines() {
  return RAW_LINES.splice(0, RAW_LINES.length).map((l) => {
    expect(l.startsWith(PREFIX)).toBe(true);
    return JSON.parse(l.slice(PREFIX.length));
  });
}

beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation((...args) => {
    const first = args[0];
    if (typeof first === "string" && first.startsWith(PREFIX)) RAW_LINES.push(first);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

// ---- fixtures --------------------------------------------------------------

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (s) => new TextEncoder().encode(s);

const PROMPT = "HelloWord-Super-Secret-Prompt-XYZ";
const key = (n) => ["sk", n].join("-");

function chatChunk(delta, finish = null, usage = null) {
  return `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "upstream-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

const roleChunk = chatChunk({ role: "assistant", content: "" });
const contentChunk = chatChunk({ content: "hello world" });
const finishChunk = chatChunk({}, "stop", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
const DONE = "data: [DONE]\n\n";
const SSE_PARTS = [roleChunk, contentChunk, finishChunk, DONE];

function completion(content) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "upstream-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function byteStream(parts, { firstDelayMs = 0, gapMs = 0 } = {}) {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= parts.length) {
        controller.close();
        return;
      }
      if (i === 0 && firstDelayMs) await delay(firstDelayMs);
      else if (i > 0 && gapMs) await delay(gapMs);
      const part = parts[i++];
      controller.enqueue(typeof part === "string" ? enc(part) : part);
    },
  });
}

function sseResponse(parts, opts = {}) {
  return new Response(byteStream(Array.isArray(parts) ? parts : [parts], opts), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

async function runChat({
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
  const res = await handleChat(req);
  const text = await res.text().catch(() => "");
  return { res, text };
}

async function defaultRespond(body) {
  await delay(5);
  return body.stream ? sseResponse(SSE_PARTS, { gapMs: 5 }) : jsonResponse(completion("ok"));
}

function makeGate(expected) {
  let arrived = 0;
  let opened = false;
  const waiting = [];
  const open = () => {
    if (opened) return;
    opened = true;
    waiting.splice(0, waiting.length).forEach((r) => r());
  };
  return {
    async wait() {
      arrived++;
      if (arrived >= expected) open();
      if (opened) return;
      await Promise.race([
        new Promise((r) => waiting.push(r)),
        delay(3000).then(open),
      ]);
    },
  };
}

const normalizeBytes = (t) =>
  t
    .replace(/"(id|request_id|session_id|system_fingerprint)":"[^"]*"/g, '"$1":"*"')
    .replace(/"created":\d+/g, '"created":*');

beforeEach(() => {
  vi.stubEnv("SHOWDAR_ROUTER_LATENCY_TRACE", "1");
  resetComboRoundRobin();
  RAW_LINES.length = 0;
  h.state.calls = [];
  h.state.combos = {};
  h.state.comboStrategies = {};
  h.state.beforeModelAttempt = async () => ({ skip: false });
  h.state.inspectModel = async () => ({ skip: false });
  h.state.validateSuccess = null;
  h.state.respond = defaultRespond;
  h.fetchMock.mockReset();
  h.fetchMock.mockImplementation(async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    h.state.calls.push({
      url: String(url),
      model: String(body.model ?? ""),
      stream: !!body.stream,
      headers: { ...(opts?.headers || {}) },
    });
    return h.state.respond(body, String(url));
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function oneLine() {
  const lines = takeLines();
  expect(lines).toHaveLength(1);
  return lines[0];
}

// ---- scenarios -------------------------------------------------------------

describe("D1 scenario 1 — flag off is a no-op", () => {
  it("disabled → zero emissions, identical bytes to the enabled run", async () => {
    vi.stubEnv("SHOWDAR_ROUTER_LATENCY_TRACE", "1");
    const onStream = await runChat({ apiKey: key(2) });
    const onJson = await runChat({ apiKey: key(2), stream: false });
    expect(takeLines()).toHaveLength(2);

    vi.stubEnv("SHOWDAR_ROUTER_LATENCY_TRACE", "0");
    const offStream = await runChat({ apiKey: key(2) });
    const offJson = await runChat({ apiKey: key(2), stream: false });
    expect(takeLines()).toHaveLength(0);

    expect(normalizeBytes(offStream.text)).toBe(normalizeBytes(onStream.text));
    expect(normalizeBytes(offJson.text)).toBe(normalizeBytes(onJson.text));
    expect(offStream.res.status).toBe(200);
  });
});

describe("D1 scenario 2 — solo streaming full marks", () => {
  it("t0..t5 present, monotonic, CLEAN_WINNER on the single attempt", async () => {
    await runChat({ apiKey: key(2) });
    const p = oneLine();

    expect(p.v).toBe(1);
    expect(p.kind).toBe("completed");
    expect(p.endpoint).toBe("/v1/chat/completions");
    expect(p.combo).toBeNull();

    expect(p.marks.t0).toBe(0);
    expect(p.marks.t1).not.toBeNull();
    expect(p.marks.t2).not.toBeNull();
    expect(p.marks.t3).not.toBeNull();
    expect(p.marks.t3m).not.toBeNull();
    expect(p.marks.t4).not.toBeNull();
    expect(p.marks.t4m).not.toBeNull();
    expect(p.marks.t5).not.toBeNull();

    expect(p.marks.t2).toBeGreaterThanOrEqual(p.marks.t1);
    expect(p.marks.t3).toBeGreaterThan(p.marks.t2);
    expect(p.marks.t3m).toBeGreaterThanOrEqual(p.marks.t3);
    expect(p.marks.t4).toBeGreaterThanOrEqual(p.marks.t3);
    expect(p.marks.t4m).toBeGreaterThanOrEqual(p.marks.t4);
    expect(p.marks.t5).toBeGreaterThanOrEqual(p.marks.t4m);

    expect(p.winner).toEqual({ ordinal: 0, model: "openai/model-a", type: "CLEAN_WINNER" });
    expect(p.attempts).toHaveLength(1);
    expect(p.attempts[0].networkAttempt).toBe(true);
    expect(p.attempts[0].result).toBe("success");
    expect(p.attempts[0].dispatchedMs).not.toBeNull();
    expect(p.attempts[0].retryDispatches).toBe(0);
    expect(p.candidates).toHaveLength(1);
    expect(p.candidates[0].networkAttempts).toBe(1);

    expect(p.stats.selectionMs).toBe(p.marks.t1);
    expect(p.stats.clientTtftMs).toBe(p.marks.t4);
    expect(p.stats.totalMs).toBe(p.marks.t5);
    expect(p.stats.fallbackAttempts).toBe(0);
    expect(p.stats.upstreamTtfbMs).toBeGreaterThan(0);
  });
});

describe("D1 scenario 3 — t3 is the first upstream body byte", () => {
  it("headers arrive immediately, body waits 40ms → t3-t2 >= 35", async () => {
    h.state.respond = async () => sseResponse(SSE_PARTS, { firstDelayMs: 40, gapMs: 5 });
    await runChat({ apiKey: key(2) });
    const p = oneLine();
    expect(p.marks.t3 - p.marks.t2).toBeGreaterThanOrEqual(35);
    expect(p.stats.upstreamTtfbMs).toBeGreaterThanOrEqual(35);
  });
});

describe("D1 scenario 4 — t3m is the first meaningful upstream token", () => {
  it("role-only chunk first, content +60ms later → t3m-t3 >= 40", async () => {
    h.state.respond = async () => sseResponse(SSE_PARTS, { gapMs: 60 });
    await runChat({ apiKey: key(2) });
    const p = oneLine();
    expect(p.marks.t3).not.toBeNull();
    expect(p.marks.t3m).not.toBeNull();
    expect(p.marks.t3m - p.marks.t3).toBeGreaterThanOrEqual(40);
    expect(p.stats.upstreamFirstMeaningfulMs).toBeGreaterThanOrEqual(p.stats.upstreamTtfbMs);
  });
});

describe("D1 scenario 5 — t4/t4m downstream marks", () => {
  it("t4 >= t3 and t4m follows the meaningful chunk (>= 40ms gap)", async () => {
    h.state.respond = async () => sseResponse(SSE_PARTS, { gapMs: 60 });
    await runChat({ apiKey: key(2) });
    const p = oneLine();
    expect(p.marks.t4).not.toBeNull();
    expect(p.marks.t4m).not.toBeNull();
    expect(p.marks.t4).toBeGreaterThanOrEqual(p.marks.t3);
    expect(p.marks.t4m - p.marks.t4).toBeGreaterThanOrEqual(40);
    expect(p.stats.clientTtftMs).toBe(p.marks.t4);
    expect(p.stats.proxyFirstByteDelayMs).not.toBeNull();
  });
});

describe("D1 scenario 6 — combo health skip is not a network attempt", () => {
  it("skipped candidate: no fetch, no attempt; winner is CLEAN", async () => {
    h.state.combos["coding-fast"] = ["openai/model-a", "openai/model-b"];
    h.state.beforeModelAttempt = async (model) =>
      String(model).includes("model-a") ? { skip: true, reason: "cooldown" } : { skip: false };

    await runChat({ model: "coding-fast", apiKey: key(2) });
    const p = oneLine();

    expect(h.state.calls).toHaveLength(1);
    expect(h.state.calls[0].model).not.toContain("model-a");

    expect(p.combo).toEqual({ name: "coding-fast", strategy: "fallback" });
    expect(p.attempts).toHaveLength(1);
    expect(p.attempts[0].model).toBe("openai/model-b");
    expect(p.attempts[0].networkAttempt).toBe(true);

    const skipped = p.candidates.find((c) => String(c.model).includes("model-a"));
    expect(skipped).toBeTruthy();
    expect(skipped.healthSkip).toBe(true);
    expect(skipped.networkAttempts).toBe(0);
    const winner = p.candidates.find((c) => String(c.model).includes("model-b"));
    expect(winner.networkAttempts).toBe(1);

    expect(p.winner.type).toBe("CLEAN_WINNER");
    expect(p.winner.model).toBe("openai/model-b");
  });
});

describe("D1 scenario 7 — fallback winner + wall-time stats", () => {
  it("503 then success → FALLBACK_WINNER, failedAttemptWallMs == unionMs", async () => {
    h.state.combos["coding-fast"] = ["openai/model-a", "openai/model-b"];
    h.state.respond = async (body) => {
      const m = String(body.model ?? "");
      if (m.includes("model-a")) {
        await delay(40);
        return jsonResponse({ error: { message: "upstream exploded" } }, 503);
      }
      await delay(5);
      return body.stream ? sseResponse(SSE_PARTS, { gapMs: 5 }) : jsonResponse(completion("ok"));
    };

    await runChat({ model: "coding-fast", apiKey: key(2) });
    const p = oneLine();

    expect(p.winner.type).toBe("FALLBACK_WINNER");
    expect(p.winner.model).toBe("openai/model-b");
    expect(p.stats.fallbackAttempts).toBe(1);
    expect(p.stats.timeBeforeWinnerMs).toBeGreaterThan(0);
    expect(p.stats.failedAttemptWallMs).toBeGreaterThan(0);
    expect(p.attempts).toHaveLength(2);
    expect(p.attempts.every((a) => a.networkAttempt)).toBe(true);
    expect(p.attempts[0].result).toBe("failure");
    expect(p.attempts[0].status).toBe(503);
    expect(p.attempts[1].result).toBe("success");

    const failed = p.attempts
      .filter((a) => a.networkAttempt && a.result !== "success" && a.startMs != null && a.endMs != null)
      .map((a) => ({ startMs: a.startMs, endMs: a.endMs }));
    // Production stores round1(unionMs(...)) — match its rounding or float noise fails toBe.
    expect(p.stats.failedAttemptWallMs).toBe(Math.round(unionMs(failed) * 10) / 10);
  });
});

describe("D1 scenario 8 — timeout classification, no fabricated bytes", () => {
  it("ETIMEDOUT → reason=timeout, upstreamFirstByteMs null", async () => {
    h.state.respond = async () => {
      await delay(2);
      throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    };

    await runChat({ apiKey: key(2) });
    const p = oneLine();

    expect(p.kind).toBe("failed");
    expect(p.attempts).toHaveLength(1);
    expect(p.attempts[0].networkAttempt).toBe(true);
    expect(p.attempts[0].result).toBe("failure");
    expect(p.attempts[0].reason).toBe("timeout");
    expect(p.attempts[0].upstreamFirstByteMs).toBeNull();
    expect(p.attempts[0].upstreamMeaningfulMs).toBeNull();
    expect(p.marks.t3).toBeNull();
    expect(p.winner).toBeNull();

    // Folded classification contract (enum order matters).
    expect(classifyFailure({ status: 502, errorText: "wrap ETIMEDOUT" })).toBe("timeout");
    expect(classifyFailure({ status: 499 })).toBe("cancelled");
    expect(classifyFailure({ aborted: true })).toBe("cancelled");
    expect(classifyFailure({ status: 429 })).toBe("rate_limited");
    expect(classifyFailure({ status: 401 })).toBe("auth");
    expect(classifyFailure({ status: 404 })).toBe("upstream_4xx");
    expect(classifyFailure({ status: 503 })).toBe("upstream_5xx");
    expect(classifyFailure({ errorText: "read ECONNRESET" })).toBe("network_error");
    expect(classifyFailure({})).toBe("unknown");
  });
});

describe("D1 scenario 9 — partial stream failure", () => {
  it("upstream dies mid-stream → kind=failed, t3 present, t5 >= t3", async () => {
    let i = 0;
    h.state.respond = async () =>
      new Response(
        new ReadableStream({
          async pull(controller) {
            if (i >= SSE_PARTS.length) {
              controller.error(new Error("boom mid-stream"));
              return;
            }
            await delay(5);
            controller.enqueue(enc(SSE_PARTS[i++]));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );

    await runChat({ apiKey: key(2) });
    const p = oneLine();
    expect(p.kind).toBe("failed");
    expect(p.marks.t3).not.toBeNull();
    expect(p.marks.t5).not.toBeNull();
    expect(p.marks.t5).toBeGreaterThanOrEqual(p.marks.t3);
    expect(p.attempts[0].result).toBe("success"); // accepted the stream, then it died
  });
});

describe("D1 scenario 10 — client cancel", () => {
  it("reader cancel → kind=cancelled, exactly one emission", async () => {
    h.state.respond = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(enc(roleChunk));
            // never closes — stream hangs after the first chunk
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );

    const res = await handleChat(
      new Request("http://localhost:21298/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + key(10) },
        body: JSON.stringify({
          model: "openai/model-a",
          stream: true,
          messages: [{ role: "user", content: PROMPT }],
        }),
      })
    );
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel("client-done");
    await delay(80);

    const p = oneLine();
    expect(p.kind).toBe("cancelled");
    expect(p.marks.t3).not.toBeNull();
    expect(takeLines()).toHaveLength(0);
  });
});

describe("D1 scenario 11 — concurrent isolation", () => {
  it("two concurrent streaming requests emit disjoint payloads", async () => {
    await Promise.all([
      runChat({ model: "openai/model-a", apiKey: key(2) }),
      runChat({ model: "openai/model-b", apiKey: key(2) }),
    ]);
    const lines = takeLines();
    expect(lines).toHaveLength(2);

    const models = lines.map((p) => p.attempts.map((a) => a.model).join(","));
    expect(models).toContain("openai/model-a");
    expect(models).toContain("openai/model-b");
    for (const p of lines) {
      expect(p.attempts).toHaveLength(1);
      // No cross-contamination: every attempt in a payload belongs to it alone.
      for (const a of p.attempts) expect(a.model).toBe(p.attempts[0].model);
      expect(p.kind).toBe("completed");
      expect(p.endpoint).toBe("/v1/chat/completions");
    }
    expect(new Set(lines.map((p) => p.attempts[0].model)).size).toBe(2);
  });
});

describe("D1 scenario 12 — single emission", () => {
  it("every request path emits exactly once; finalize is first-wins", async () => {
    await runChat({ apiKey: key(2) });
    expect(takeLines()).toHaveLength(1);

    await runChat({ apiKey: key(2), stream: false });
    expect(takeLines()).toHaveLength(1);

    h.state.combos["coding-fast"] = ["openai/model-a", "openai/model-b"];
    await runChat({ model: "coding-fast", apiKey: key(2) });
    expect(takeLines()).toHaveLength(1);

    h.state.respond = async () => {
      await delay(2);
      throw new Error("nope");
    };
    await runChat({ apiKey: key(2) });
    expect(takeLines()).toHaveLength(1);

    // finalize-twice unit: first terminal wins, never a second line.
    const t = createLatencyTrace({ endpoint: "/unit" });
    expect(t).toBeTruthy();
    t.finalize("completed");
    t.finalize("failed");
    t.finalize("cancelled");
    const unit = oneLine();
    expect(unit.kind).toBe("completed");
    expect(unit.endpoint).toBe("/unit");
    expect(takeLines()).toHaveLength(0);
  });
});

describe("D1 scenario 13 — attempt accounting excludes health skips", () => {
  it("health-skipped model: no attempt, no fetch; winner CLEAN; retryDispatches 0", async () => {
    h.state.combos["coding-fast"] = ["openai/model-a", "openai/model-b"];
    h.state.beforeModelAttempt = async (model) =>
      String(model).includes("model-a") ? { skip: true, reason: "route_unhealthy" } : { skip: false };

    await runChat({ model: "coding-fast", apiKey: key(2) });
    const p = oneLine();

    expect(p.attempts).toHaveLength(1);
    expect(p.attempts[0].retryDispatches).toBe(0);
    expect(p.attempts[0].authRefresh).toBe(false);
    expect(h.state.calls).toHaveLength(1);

    const byModel = Object.fromEntries(p.candidates.map((c) => [c.model, c]));
    expect(byModel["openai/model-a"].networkAttempts).toBe(0);
    expect(byModel["openai/model-a"].healthSkip).toBe(true);
    expect(byModel["openai/model-a"].healthSkipReason).toBeTruthy();
    expect(byModel["openai/model-b"].networkAttempts).toBe(1);
    expect(p.winner.type).toBe("CLEAN_WINNER");
  });
});

describe("D1 scenario 14 — payload is enumeration-safe", () => {
  it("no secrets, prompts, ids, bearer tokens or raw error text", async () => {
    h.state.combos["coding-fast"] = ["openai/model-a", "openai/model-b"];
    h.state.respond = async (body) => {
      const m = String(body.model ?? "");
      if (m.includes("model-a")) {
        await delay(5);
        return jsonResponse({ error: { message: "SECRET_MARKER_12345 boom" } }, 500);
      }
      await delay(5);
      return body.stream ? sseResponse(SSE_PARTS, { gapMs: 5 }) : jsonResponse(completion("ok"));
    };

    await runChat({ model: "coding-fast", apiKey: key(2) });
    const p = oneLine();
    const raw = JSON.stringify(p);

    expect(raw).not.toContain(PROMPT);
    expect(raw).not.toContain("SECRET_MARKER_12345");
        expect(raw).not.toContain("Bearer");
    expect(raw).not.toMatch(/msg_/);
    expect(raw).not.toMatch(/ses_/);
    expect(raw).not.toContain(key(14));

    expect(raw).toContain('"endpoint":"/v1/chat/completions"');
    expect(raw).toContain('"marks"');
    expect(raw).toContain("openai/model-a");
    expect(raw).toContain("openai/model-b");
    expect(p.attempts[0].reason).toBe("upstream_5xx"); // enum only
  });
});

describe("D1 scenario 15 — non-streaming", () => {
  it("no fabricated TTFT: t3/t4/clientTtftMs null, kind completed", async () => {
await runChat({ model: "deepseek/model-a", apiKey: key(2), stream: false });
    const p = oneLine();

    expect(p.kind).toBe("completed");
    expect(p.marks.t3).toBeNull();
    expect(p.marks.t3m).toBeNull();
    expect(p.marks.t4).toBeNull();
    expect(p.marks.t4m).toBeNull();
    expect(p.stats.clientTtftMs).toBeNull();
    expect(p.stats.upstreamTtfbMs).toBeNull();
    expect(p.stats.upstreamFirstMeaningfulMs).toBeNull();
    expect(p.stats.proxyFirstByteDelayMs).toBeNull();
    expect(p.attempts[0].upstreamFirstByteMs).toBeNull();
    expect(p.attempts[0].firstByteMs).toBeNull();
    expect(p.marks.t1).not.toBeNull();
    expect(p.marks.t2).not.toBeNull();
    expect(p.stats.totalMs).not.toBeNull();
    expect(p.winner.type).toBe("CLEAN_WINNER");
  });
});

describe("D1 scenario 16 — fusion gated panel barrier", () => {
  it("2 panel failures overlap: failedAttemptWallMs == unionMs < sum, judge wins", async () => {
    h.state.combos["fusion-combo"] = [
      "openai/model-a",
      "openai/model-b",
      "openai/model-c",
      "openai/model-d",
    ];
    h.state.comboStrategies["fusion-combo"] = {
      fallbackStrategy: "fusion",
      judgeModel: "openai/model-judge",
    };

    const gate = makeGate(4);
    h.state.respond = async (body) => {
      const m = String(body.model ?? "");
      // forceStream providers hand the panel/judge path SSE upstreams;
      // handleForcedSSEToJson converts them for fusion's JSON extraction.
      const sse = (content) => sseResponse([roleChunk, chatChunk({ content }), finishChunk, DONE]);
      if (m.includes("model-judge")) {
        await delay(5);
        return sse("final judge answer");
      }
      // All four panels hold at the gate until every one has arrived —
      // guarantees overlapping failure spans for the union assertion.
      await gate.wait();
      if (m.includes("model-a") || m.includes("model-c")) {
        return jsonResponse({ error: { message: "panel down" } }, 503);
      }
      return sse(`answer for ${m}`);
    };

    await runChat({ model: "fusion-combo", apiKey: key(2), stream: false });
    const p = oneLine();

    expect(p.kind).toBe("completed");
    expect(p.combo).toEqual({ name: "fusion-combo", strategy: "fusion" });
    expect(p.attempts).toHaveLength(5);
    expect(p.attempts.every((a) => a.networkAttempt)).toBe(true);

    const wi = p.attempts.findIndex(
      (a) => a.model === "openai/model-judge" && a.result === "success"
    );
    expect(wi).toBe(4);
    expect(p.winner).toEqual({ ordinal: -1, model: "openai/model-judge", type: "FALLBACK_WINNER" });
    expect(p.stats.fallbackAttempts).toBe(2);
    expect(p.stats.timeBeforeWinnerMs).toBeGreaterThan(0);

    const earlierFailed = p.attempts
      .slice(0, wi)
      .filter((a) => a.networkAttempt && a.result !== "success");
    expect(earlierFailed).toHaveLength(2);

    const spans = earlierFailed.map((a) => ({ startMs: a.startMs, endMs: a.endMs }));
    const union = Math.round(unionMs(spans) * 10) / 10;
    const sum = spans.reduce((s, x) => s + (x.endMs - x.startMs), 0);

    expect(p.stats.failedAttemptWallMs).toBe(union);
    expect(p.stats.failedAttemptWallMs).toBeGreaterThan(0);
    expect(p.stats.failedAttemptWallMs).toBeLessThan(sum);

    // 4 panel candidates + judge candidate.
    expect(p.candidates).toHaveLength(5);
    const judgeCandidate = p.candidates.find((c) => c.model === "openai/model-judge");
    expect(judgeCandidate.networkAttempts).toBe(1);
  });
});

describe("D1 scenario 17 — validator consumes attempt-1 stream, fallback still wins", () => {
  it("empty 200 SSE rejected by the production validator → one late emission with attempt 2 as winner", async () => {
    h.state.validateSuccess = validateChatComboResponse;
    h.state.combos["coding-fast"] = ["openai/model-a", "openai/model-b"];
    h.state.respond = async (body) => {
      const m = String(body.model ?? "");
      if (m.includes("model-a")) {
        // HTTP 200 SSE that never carries meaningful content: the validator
        // reads it to stream end (driving handleComplete) before rejecting.
        await delay(5);
        return sseResponse([roleChunk, DONE], { gapMs: 5 });
      }
      await delay(5);
      return body.stream ? sseResponse(SSE_PARTS, { gapMs: 5 }) : jsonResponse(completion("ok"));
    };

    await runChat({ model: "coding-fast", apiKey: key(2) });
    const p = oneLine();

    expect(p.kind).toBe("completed");
    expect(p.attempts).toHaveLength(2);
    expect(p.attempts[0].model).toBe("openai/model-a");
    expect(p.attempts[0].networkAttempt).toBe(true);
    expect(p.attempts[0].result).toBe("failure");
    expect(p.attempts[0].reason).toBe("invalid_response");
    expect(p.attempts[0].endMs).not.toBeNull();
    expect(p.attempts[1].model).toBe("openai/model-b");
    expect(p.attempts[1].result).toBe("success");
    expect(p.winner).toMatchObject({ ordinal: 1, model: "openai/model-b", type: "FALLBACK_WINNER" });
    expect(p.stats.fallbackAttempts).toBe(1);
    // Client did receive bytes (attempt 2 via the validator's replay).
    expect(p.marks.t4).not.toBeNull();
    expect(p.marks.t5).not.toBeNull();
    // Emission happened after both attempts, not mid-validation.
    expect(takeLines()).toHaveLength(0);
  });
});

describe("D1 scenario 18 — scanner edge cases", () => {
  it("whitespace-only deltas are not meaningful; CRLF/split/malformed/cap all fail open", () => {
    const s = createMeaningfulScanner();
    expect(s.push(enc(roleChunk))).toBe(false);
    expect(s.push(enc(chatChunk({ content: " " })))).toBe(false);
    expect(s.push(enc(chatChunk({ content: "real text" })))).toBe(true);

    // CRLF line endings, split across chunk boundaries mid-line.
    const crlf = chatChunk({ content: "crlf text" }).replace(/\n/g, "\r\n");
    const s2 = createMeaningfulScanner();
    expect(s2.push(crlf.slice(0, 17))).toBe(false);
    expect(s2.push(crlf.slice(17))).toBe(true);

    // Terminal sentinel and malformed JSON never throw and never count.
    const s3 = createMeaningfulScanner();
    expect(s3.push("data: [DONE]\n\n")).toBe(false);
    expect(s3.push("data: {broken\n\n")).toBe(false);
    expect(s3.push(": keep-alive comment\n\n")).toBe(false);
    expect(s3.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`)).toBe(true);

    // Over the buffer cap the scanner releases itself: fail-open to null.
    const s4 = createMeaningfulScanner();
    expect(s4.push(`data: ${"x".repeat(70 * 1024)}`)).toBe(false);
    expect(s4.push(enc(contentChunk))).toBe(false);
  });
});
