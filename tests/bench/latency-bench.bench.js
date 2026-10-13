/**
 * Phase D1 benchmark (§9) — latency-trace overhead on real request paths.
 *
 * End-to-end through handleChat → combo/fusion → (mocked) executor →
 * globalThis.fetch (patched by proxyFetch) → a LOCAL http.createServer mock
 * SSE provider on 127.0.0.1 (real sockets, real bytes).
 *
 * Paths:
 *  A-off / A-on : solo direct model, trace flag off / on  (overhead delta)
 *  B            : combo "coding-fast" (fallback strategy), trace on
 *  C            : combo whose first model is always 503 → FALLBACK winner, trace on
 *
 * Run (from tests/):  npx vitest run --config bench/vitest.bench.config.js
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const h = vi.hoisted(() => {
  const rawFetch = globalThis.fetch;
  const fetchMock = vi.fn();
  // proxyFetch captures globalThis.fetch at module load — patch before imports.
  globalThis.fetch = fetchMock;
  return {
    rawFetch,
    fetchMock,
    state: {
      port: 0,
      emissions: 0,
      combos: {
        "coding-fast": ["openai/model-a", "openai/model-b"],
        "fallback-combo": ["openai/model-flaky", "openai/model-solid"],
      },
      comboStrategies: {},
      beforeModelAttempt: async () => ({ skip: false }),
      inspectModel: async () => ({ skip: false }),
    },
    server: null,
  };
});

// ---- mocks (same harness as tests/unit/latency-trace.test.js) --------------

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

vi.mock("@/sse/services/comboHealthHooks.js", () => ({
  createChatComboHealthHooks: () => ({
    inspectModel: (...args) => h.state.inspectModel(...args),
    beforeModelAttempt: (...args) => h.state.beforeModelAttempt(...args),
    onModelSuccess: async () => {},
    onModelFailure: async () => {},
    onModelCancelled: async () => {},
    validateSuccess: null,
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

// ---- local mock SSE provider ------------------------------------------------

const PREFIX = "[showdar-latency] ";

function sseEvent(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "upstream-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

beforeAll(async () => {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* keep {} */ }
      const model = String(body.model || "");
      if (model.includes("flaky")) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "flaky provider down" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunks = [
        sseEvent({ role: "assistant", content: "" }),
        sseEvent({ content: `answer from ${model}` }),
        sseEvent({}, "stop"),
        "data: [DONE]\n\n",
      ];
      for (const c of chunks) {
        res.write(c);
        await new Promise((r) => setTimeout(r, 1));
      }
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  h.server = server;
  h.state.port = server.address().port;

  // Executor path stays upstream.example; route it to the local server here.
  h.fetchMock.mockImplementation((url, opts) =>
    h.rawFetch(`http://127.0.0.1:${h.state.port}/v1/chat/completions`, opts)
  );

  vi.spyOn(console, "error").mockImplementation((...args) => {
    if (typeof args[0] === "string" && args[0].startsWith(PREFIX)) h.state.emissions++;
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await new Promise((r) => (h.server ? h.server.close(r) : r()));
});

beforeEach(() => {
  resetComboRoundRobin();
  h.state.emissions = 0;
});

// ---- measurement helpers ----------------------------------------------------

const N = 40;
const WARMUP = 5;
const key = ["sk", "bench"].join("-");

async function oneRequest(model) {
  const req = new Request("http://localhost:21298/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "user", content: "benchmark prompt" }],
    }),
  });
  const t0 = performance.now();
  const res = await handleChat(req);
  await res.text();
  return performance.now() - t0;
}

async function runPath(model, traceFlag) {
  vi.stubEnv("SHOWDAR_ROUTER_LATENCY_TRACE", traceFlag);
  h.state.emissions = 0;
  for (let i = 0; i < WARMUP; i++) await oneRequest(model);
  h.state.emissions = 0; // count only the measured runs
  const samples = [];
  for (let i = 0; i < N; i++) samples.push(await oneRequest(model));
  return { samples, emissions: h.state.emissions };
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.ceil(q * (s.length - 1)))];
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    median: at(0.5),
    p90: at(0.9),
    min: s[0],
    max: s[s.length - 1],
    mean: sum / s.length,
  };
}

const fmt = (v) => `${v.toFixed(1)}ms`;

describe("Phase D1 latency-trace benchmark", () => {
  it(`median/p90 over ${N} requests per path; trace-on overhead on solo path`, async () => {
    const aOff = await runPath("openai/model-a", "0");
    const aOn = await runPath("openai/model-a", "1");
    const bOn = await runPath("coding-fast", "1");
    const cOn = await runPath("fallback-combo", "1");

    // Emission contract: flag off → silent; every other path → one line per request.
    expect(aOff.emissions).toBe(0);
    expect(aOn.emissions).toBe(N);
    expect(bOn.emissions).toBe(N);
    expect(cOn.emissions).toBe(N);

    const rows = [
      ["A solo (trace off)", stats(aOff.samples)],
      ["A solo (trace on)", stats(aOn.samples)],
      ["B combo fallback (on)", stats(bOn.samples)],
      ["C 503→success fallback (on)", stats(cOn.samples)],
    ];
    const overhead = stats(aOn.samples).median - stats(aOff.samples).median;

    const table = rows.map(([name, st]) =>
      `${name.padEnd(30)} median=${fmt(st.median)}  p90=${fmt(st.p90)}  min=${fmt(st.min)}  max=${fmt(st.max)}`
    );
    const report =
      `[bench] n=${N} per path (warmup ${WARMUP}), local mock SSE provider on 127.0.0.1:${h.state.port}\n` +
      table.join("\n") +
      `\n[bench] trace-on − trace-off median overhead (solo): ${overhead >= 0 ? "+" : ""}${overhead.toFixed(2)}ms\n`;
    // Written to a file as well as logged: the reporter may swallow console
    // output of passing tests, and the report needs to be readable after the run.
    writeFileSync(__dirname + "bench-results.txt", report);
    console.log(report);

    // Generous sanity bounds — catches pathological hangs, not noise.
    for (const [, st] of rows) expect(st.p90).toBeLessThan(2000);
    // Overhead of the observability layer must stay small (sub-50ms median).
    expect(overhead).toBeLessThan(50);
  }, 120000);
});
