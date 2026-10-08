/**
 * Phase A.1 — OpenCode production-path hardening.
 *
 * 16 scenarios across four independently identified gaps:
 *  1. Stable session identity (no per-request session churn for noauth/unsourced requests)
 *  2. One request ID per logical request (identical prompts never collide; retries reuse)
 *  3. Responses-path tool fingerprint + decoy tool-call leakage prevention
 *  4. Forced-SSE JSON conversion: first-chunk/idle deadlines, cancellation, truncation
 *
 * Gap-1/2/3 flows run through the actual request path (handleChat → chatCore →
 * OpenCodeExecutor → fetch), with the upstream call captured at the fetch boundary.
 * Gap-4 forced-SSE tests exercise handleForcedSSEToJson / the converter directly
 * with explicit deadline options.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const fetchMock = vi.fn();
  // proxyFetch captures globalThis.fetch at module load — must be our mock before any import.
  globalThis.fetch = fetchMock;
  return { fetchMock };
});

vi.mock("../../open-sse/executors/index.js", async () => {
  const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
  const capture = [];
  return {
    getExecutor(provider) {
      if (provider === "opencode") return new OpenCodeExecutor();
      return {
        noAuth: true,
        execute: async (args) => {
          capture.push({ provider, ...args });
          return {
            response: new Response(
              JSON.stringify({
                id: "c-other",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            ),
            url: "https://upstream.example/v1/chat/completions",
            headers: {},
            transformedBody: args.body,
          };
        },
      };
    },
    __capture: capture,
  };
});

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
    id: "noauth",
    connectionName: "Public",
    isActive: true,
    accessToken: "public",
    providerSpecificData: {},
  })),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false, cooldownMs: 0 })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: (req) =>
    req?.headers?.get?.("authorization")?.startsWith("Bearer ")
      ? req.headers.get("authorization").slice(7)
      : null,
  isValidApiKey: vi.fn(async () => true),
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
    comboStrategies: {},
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
  getComboModels: vi.fn(async () => null),
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(async () => {}),
  checkAndRefreshToken: vi.fn(async (_provider, creds) => creds),
}));

vi.mock("@/sse/services/comboHealthHooks.js", () => ({
  createChatComboHealthHooks: () => ({}),
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

vi.mock("../../open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  detectRequiredCapabilities: vi.fn(() => []),
}));

vi.mock("../../open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((fn) => fn),
  getActiveAdapterStrategy: vi.fn(() => "fallback"),
}));

vi.mock("../../open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn(async () => null),
}));

const { handleChat } = await import("@/sse/handlers/chat.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const execModule = await import("../../open-sse/executors/index.js");

const VALID_MSG_ID = "msg_abcdef123456ABCDEFGHIJKLMN";
const CALLS = [];
const capture = execModule.__capture;

const enc = (s) => new TextEncoder().encode(s);
const nowMs = () => Date.now();

function chatChunk(delta, finish = null, usage = null) {
  return `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "big-pickle",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

function chatSSEPlain() {
  return (
    chatChunk({ role: "assistant", content: "" }) +
    chatChunk({ content: "hello world" }) +
    chatChunk({}, "stop", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }) +
    "data: [DONE]\n\n"
  );
}

// Upstream chat SSE that calls both a decoy tool (bash) and a real client tool.
function chatSSEWithTools() {
  return (
    chatChunk({ role: "assistant", content: "" }) +
    chatChunk({ content: "hello world" }) +
    chatChunk({ tool_calls: [{ index: 0, id: "call_bash", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }] }) +
    chatChunk({ tool_calls: [{ index: 1, id: "call_exe", type: "function", function: { name: "exec_command", arguments: '{"cmd":"ls"}' } }] }) +
    chatChunk({}, "tool_calls", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }) +
    "data: [DONE]\n\n"
  );
}

function responsesEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function responsesSSEMinimal() {
  return (
    responsesEvent("response.created", { response: { id: "resp_1", status: "in_progress" } }) +
    responsesEvent("response.completed", {
      response: { id: "resp_1", status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 }, output: [] },
    })
  );
}

// Responses upstream emitting a decoy function call (bash) and a real one (exec_command).
function responsesSSEWithTools() {
  return (
    responsesEvent("response.created", { response: { id: "resp_1", status: "in_progress" } }) +
    responsesEvent("response.output_item.added", { output_index: 0, item: { type: "function_call", id: "fc_bash", call_id: "call_bash", name: "bash", arguments: "" } }) +
    responsesEvent("response.function_call_arguments.delta", { item_id: "fc_bash", delta: "{}" }) +
    responsesEvent("response.output_item.done", { output_index: 0, item: { type: "function_call", id: "fc_bash", call_id: "call_bash", name: "bash", arguments: "{}" } }) +
    responsesEvent("response.output_item.added", { output_index: 1, item: { type: "function_call", id: "fc_exe", call_id: "call_exe", name: "exec_command", arguments: "" } }) +
    responsesEvent("response.output_item.done", { output_index: 1, item: { type: "function_call", id: "fc_exe", call_id: "call_exe", name: "exec_command", arguments: '{"cmd":"ls"}' } }) +
    responsesEvent("response.completed", {
      response: {
        id: "resp_1",
        status: "completed",
        usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
        output: [],
      },
    })
  );
}

function neverStream() {
  return new ReadableStream({ start() {} });
}

// Serve an SSE text as many tiny byte slices so lines/frames split across
// network chunks — exercises the buffer accumulate + event-hold paths.
function chunkedSSE(text, slice) {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(i, i + slice));
      i += slice;
    },
  });
}

function stallAfterOneEvent() {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(enc('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n'));
      }
      // never enqueue again, never close → consumer read() stays pending
    },
  });
}

function truncatedResponsesStream() {
  const text =
    responsesEvent("response.created", { response: { id: "resp_1", status: "in_progress" } }) +
    responsesEvent("response.output_item.done", {
      output_index: 0,
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] },
    });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc(text));
      controller.close();
    },
  });
  return stream;
}

async function runChat({
  model = "opencode/big-pickle",
  apiKey = "sk-test",
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
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hello" }], ...body }),
  });
  const res = await handleChat(req);
  const text = await res.text().catch(() => "");
  return { res, text };
}

function lastCall() {
  return CALLS[CALLS.length - 1];
}

function baseChatCoreArgs(overrides = {}) {
  const { clientStream, ...rest } = overrides;
  return {
    body: { model: "opencode/big-pickle", stream: clientStream !== false, messages: [{ role: "user", content: "hello" }] },
    modelInfo: { provider: "opencode", model: "big-pickle" },
    credentials: { id: "noauth", accessToken: "public", providerSpecificData: {} },
    log: null,
    apiKey: "sk-core",
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    pxpipeEnabled: false,
    ...rest,
  };
}

beforeEach(() => {
  CALLS.length = 0;
  capture.length = 0;
  h.fetchMock.mockReset();
  h.fetchMock.mockImplementation(async (url, opts) => {
    CALLS.push({
      url: String(url),
      headers: { ...(opts?.headers || {}) },
      body: opts?.body ? JSON.parse(opts.body) : null,
    });
    return new Response(String(url).includes("/zen/v1/responses") ? responsesSSEMinimal() : chatSSEPlain(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
});

describe("gap 1 — stable session identity", () => {
  // Scenario 1
  it("same identity, no hint → identical upstream session across requests", async () => {
    await runChat({ apiKey: "sk-g1s1" });
    await runChat({ apiKey: "sk-g1s1" });
    const a = CALLS[0].headers["x-opencode-session"];
    const b = CALLS[1].headers["x-opencode-session"];
    expect(a).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(b).toBe(a);
  });

  // Scenario 1b (A.1.1): assistant history appearing on turn 2 must not flip
  // the upstream session established on turn 1 — same conversation identity
  // ⇒ turn 1 = turn 2 = turn N.
  it("assistant history appearing later does not flip the upstream session", async () => {
    await runChat({ apiKey: "session-flip-identity", body: { messages: [{ role: "user", content: "first turn" }] } });
    const turn1 = CALLS[0].headers["x-opencode-session"];
    await runChat({
      apiKey: "session-flip-identity",
      body: {
        messages: [
          { role: "user", content: "first turn" },
          { role: "assistant", content: "x".repeat(120) },
          { role: "user", content: "second turn" },
        ],
      },
    });
    const turn2 = CALLS[1].headers["x-opencode-session"];
    await runChat({
      apiKey: "session-flip-identity",
      body: {
        messages: [
          { role: "user", content: "first turn" },
          { role: "assistant", content: "x".repeat(120) },
          { role: "user", content: "second turn" },
          { role: "assistant", content: "y".repeat(120) },
          { role: "user", content: "third turn" },
        ],
      },
    });
    const turn3 = CALLS[2].headers["x-opencode-session"];
    expect(turn1).toMatch(/^ses_/);
    expect(turn2).toBe(turn1);
    expect(turn3).toBe(turn1);
  });

  // Scenario 2
  it("different identities, no hint → distinct upstream sessions", async () => {
    await runChat({ apiKey: "sk-g1s2a" });
    await runChat({ apiKey: "sk-g1s2b" });
    expect(CALLS[1].headers["x-opencode-session"]).not.toBe(CALLS[0].headers["x-opencode-session"]);
  });

  // Scenario 3
  it("explicit conversation hint reused → same canonical ses_ (noncanonical mapped)", async () => {
    await runChat({ apiKey: "sk-g1s3", headers: { "x-session-id": "MyConvo-42" } });
    await runChat({ apiKey: "sk-g1s3-other", headers: { "x-session-id": "MyConvo-42" } });
    const a = CALLS[0].headers["x-opencode-session"];
    expect(a).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(CALLS[1].headers["x-opencode-session"]).toBe(a);
  });

  // Scenario 4
  it("different explicit conversation hints → distinct sessions", async () => {
    await runChat({ apiKey: "sk-g1s4", headers: { "x-session-id": "conv-A" } });
    await runChat({ apiKey: "sk-g1s4", headers: { "x-session-id": "conv-B" } });
    expect(CALLS[1].headers["x-opencode-session"]).not.toBe(CALLS[0].headers["x-opencode-session"]);
  });

  // Scenario 7
  it("concurrent requests with different identities don't cross-contaminate", async () => {
    await Promise.all([runChat({ apiKey: "sk-g1s7a" }), runChat({ apiKey: "sk-g1s7b" })]);
    const sessions = CALLS.map((c) => c.headers["x-opencode-session"]);
    const requests = CALLS.map((c) => c.headers["x-opencode-request"]);
    expect(sessions[0]).not.toBe(sessions[1]);
    expect(requests[0]).not.toBe(requests[1]);
    for (const s of sessions) expect(s).toMatch(/^ses_/);
  });

  // Scenario 8
  it("session identity is provider-scoped — opencode session never leaks to other providers", async () => {
    await runChat({ apiKey: "sk-g1s8" });
    const opencodeSessions = new Set(CALLS.map((c) => c.headers["x-opencode-session"]));

    await runChat({ model: "kilocode/openai/gpt-4.1", stream: false, apiKey: "sk-g1s8" });
    await runChat({ model: "kilocode/openai/gpt-4.1", stream: false, apiKey: "sk-g1s8" });
    const kilo = capture.filter((c) => c.provider === "kilocode");
    expect(kilo.length).toBeGreaterThanOrEqual(2);
    const s1 = kilo[kilo.length - 2].providerSessionId;
    const s2 = kilo[kilo.length - 1].providerSessionId;
    // Stable per identity…
    expect(s2).toBe(s1);
    // …and never the OpenCode session.
    expect(s1).not.toMatch(/^ses_/);
    expect(opencodeSessions.has(s1)).toBe(false);
  });
});

describe("gap 2 — one request id per logical request", () => {
  // Scenario 5
  it("identical prompts produce distinct request ids; explicit client id preserved", async () => {
    // Pin the session so a per-request session cannot mask a content-hash collision.
    const pinned = { "x-session-id": "pinned-convo" };
    await runChat({ apiKey: "sk-g2s5", headers: pinned });
    await runChat({ apiKey: "sk-g2s5", headers: pinned });
    const a = CALLS[0].headers["x-opencode-request"];
    const b = CALLS[1].headers["x-opencode-request"];
    expect(a).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(b).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(b).not.toBe(a);

    await runChat({ apiKey: "sk-g2s5", headers: { "x-opencode-request": VALID_MSG_ID } });
    expect(lastCall().headers["x-opencode-request"]).toBe(VALID_MSG_ID);

    // Validation: a malformed client request id is never echoed — the request
    // falls back to the deterministic canonical id for this logical request.
    await runChat({ apiKey: "session-flip-identity", headers: { "x-opencode-request": "not-a-msg-id" } });
    const rejected = lastCall().headers["x-opencode-request"];
    expect(rejected).toMatch(/^msg_/);
    expect(rejected).not.toBe("not-a-msg-id");
  });

  // Scenario 6
  it("one logical request carried across internal retries keeps one request id; a missing id falls back to a fresh one", async () => {
    const sharedRaw = { endpoint: "/v1/chat/completions", body: {}, headers: {}, logicalRequestId: "urn:lr:aaaa-bbbb-cccc" };
    const run = (clientRawRequest) =>
      handleChatCore(baseChatCoreArgs({ stream: false, clientRawRequest }));

    let r = await run(sharedRaw);
    expect(r.success).toBe(true);
    const id1 = lastCall().headers["x-opencode-request"];
    r = await run(sharedRaw);
    expect(r.success).toBe(true);
    const id2 = lastCall().headers["x-opencode-request"];
    expect(id2).toBe(id1);
    expect(id1).toMatch(/^msg_/);

    // Same logical request, different target model → distinct ids (combo legs
    // are different upstream requests, not retries).
    r = await handleChatCore(
      baseChatCoreArgs({
        clientRawRequest: { ...sharedRaw },
        modelInfo: { provider: "opencode", model: "other-model" },
        body: { model: "opencode/other-model", stream: false, messages: [{ role: "user", content: "hello" }] },
      })
    );
    expect(r.success).toBe(true);
    const id5 = lastCall().headers["x-opencode-request"];
    expect(id5).toMatch(/^msg_/);
    expect(id5).not.toBe(id1);

    // No clientRawRequest → each chatCore invocation is its own logical request.
    r = await handleChatCore(baseChatCoreArgs({ stream: false }));
    const id3 = lastCall().headers["x-opencode-request"];
    r = await handleChatCore(baseChatCoreArgs({ stream: false }));
    const id4 = lastCall().headers["x-opencode-request"];
    expect(id4).not.toBe(id3);
  });
});

describe("gap 3 — tool fingerprints and decoy leakage", () => {
  // Scenario 9
  it("chat path injects bash+read decoys alongside the client tool, without duplicates", async () => {
    await runChat({
      apiKey: "sk-g3s9",
      body: {
        tools: [{ type: "function", function: { name: "exec_command", description: "run", parameters: { type: "object", properties: {} } } }],
      },
    });
    const names = (lastCall().body.tools || []).map((t) => t.function?.name || t.name);
    expect(names).toContain("exec_command");
    expect(names).toContain("bash");
    expect(names).toContain("read");
    expect(new Set(names).size).toBe(names.length);
  });

  // Scenario 10
  it("Responses path injects bash+read decoys alongside the client tool too", async () => {
    await runChat({
      model: "opencode/muse-spark-1.3-contributor-free",
      apiKey: "sk-g3s10",
      url: "http://localhost:21298/v1/responses",
      body: {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        messages: undefined,
        tools: [{ type: "function", name: "exec_command", description: "run", parameters: { type: "object", properties: {} } }],
      },
    });
    expect(lastCall().url).toContain("/zen/v1/responses");
    const names = (lastCall().body.tools || []).map((t) => t.name || t.function?.name);
    expect(names).toContain("exec_command");
    expect(names).toContain("bash");
    expect(names).toContain("read");
    expect(new Set(names).size).toBe(names.length);
    expect(lastCall().body.tool_choice).toBe("auto");
  });

  // Scenario 11a
  it("chat-format upstream tool calls: client sees its own tool, never the injected decoy", async () => {
    h.fetchMock.mockImplementation(async (url, opts) => {
      CALLS.push({ url: String(url), headers: { ...(opts?.headers || {}) }, body: JSON.parse(opts.body) });
      return new Response(chatSSEWithTools(), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const { text } = await runChat({
      apiKey: "sk-g3s11a",
      body: {
        tools: [{ type: "function", function: { name: "exec_command", description: "run", parameters: { type: "object", properties: {} } } }],
      },
    });
    expect(text).toContain("exec_command");
    expect(text).not.toMatch(/"name"\s*:\s*"bash"/);
    // Passthrough forwarding (not the translate machinery) must keep the
    // OpenAI terminator — clients hang without it.
    expect(text).toContain("data: [DONE]");
  });

  // Scenario 11b
  it("Responses-format upstream tool calls: client sees its own tool, never the injected decoy", async () => {
    h.fetchMock.mockImplementation(async (url, opts) => {
      CALLS.push({ url: String(url), headers: { ...(opts?.headers || {}) }, body: JSON.parse(opts.body) });
      return new Response(responsesSSEWithTools(), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const { text } = await runChat({
      model: "opencode/muse-spark-1.3-contributor-free",
      apiKey: "sk-g3s11b",
      url: "http://localhost:21298/v1/responses",
      body: {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        messages: undefined,
        tools: [{ type: "function", name: "exec_command", description: "run", parameters: { type: "object", properties: {} } }],
      },
    });
    expect(text).toContain("exec_command");
    expect(text).not.toMatch(/"name"\s*:\s*"bash"/);
    // Dropped decoy data lines must take their event: prefix with them —
    // an orphan `event:` would desync the client's framing.
    expect(text).not.toMatch(/event:[^\n]+\n(?!data:)/);
  });

  // A.1.1 §4: fragmented frames + CRLF endings must filter identically.
  it("fragmented CRLF chat frames: decoy dropped, real tool + [DONE] kept", async () => {
    const crlf = chatSSEWithTools().replace(/\n/g, "\r\n");
    h.fetchMock.mockImplementation(async (url, opts) => {
      CALLS.push({ url: String(url), headers: { ...(opts?.headers || {}) }, body: JSON.parse(opts.body) });
      return new Response(chunkedSSE(crlf, 7), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const { text } = await runChat({
      apiKey: "session-flip-identity",
      body: {
        tools: [{ type: "function", function: { name: "exec_command", description: "run", parameters: { type: "object", properties: {} } } }],
      },
    });
    expect(text).toContain("exec_command");
    expect(text).not.toMatch(/"name"\s*:\s*"bash"/);
    expect(text).toContain("[DONE]");
  });

  // A.1.1 §4: a client-defined tool legitimately named "bash" must survive —
  // filtering is provenance-based (request-local injected-name set), not a
  // blanket name blacklist.
  it("client tool named bash is never dropped; only the injected read decoy is", async () => {
    h.fetchMock.mockImplementation(async (url, opts) => {
      CALLS.push({ url: String(url), headers: { ...(opts?.headers || {}) }, body: JSON.parse(opts.body) });
      return new Response(
        chatChunk({ role: "assistant", content: "" }) +
          chatChunk({ tool_calls: [{ index: 0, id: "call_b1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }] }) +
          chatChunk({ tool_calls: [{ index: 1, id: "call_r1", type: "function", function: { name: "read", arguments: '{"path":"f"}' } }] }) +
          chatChunk({}, "tool_calls", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }) +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });
    const { text } = await runChat({
      apiKey: "session-flip-identity",
      body: {
        tools: [
          { type: "function", function: { name: "bash", description: "shell", parameters: { type: "object", properties: {} } } },
          { type: "function", function: { name: "exec_command", description: "run", parameters: { type: "object", properties: {} } } },
        ],
      },
    });
    // Cloak must not duplicate the client's bash…
    const upstreamNames = (lastCall().body.tools || []).map((t) => t.function?.name);
    expect(upstreamNames.filter((n) => n === "bash").length).toBe(1);
    // …and the client's own bash call survives while the injected read decoy dies.
    expect(text).toContain('"name":"bash"');
    expect(text).not.toMatch(/"name"\s*:\s*"read"/);
    expect(text).toContain("[DONE]");
  });

  // A.1.1 §4: tool calls spanning multiple deltas — argument-only deltas follow
  // the name-bearing delta (dropped for the decoy by index, kept for the client tool).
  it("multi-delta tool calls: decoy argument deltas dropped, client argument deltas kept", async () => {
    h.fetchMock.mockImplementation(async (url, opts) => {
      CALLS.push({ url: String(url), headers: { ...(opts?.headers || {}) }, body: JSON.parse(opts.body) });
      return new Response(
        chatChunk({ role: "assistant", content: "" }) +
          chatChunk({ tool_calls: [{ index: 0, id: "call_bash", type: "function", function: { name: "bash", arguments: "" } }] }) +
          chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":"evil"}' } }] }) +
          chatChunk({ tool_calls: [{ index: 1, id: "call_exe", type: "function", function: { name: "exec_command", arguments: "" } }] }) +
          chatChunk({ tool_calls: [{ index: 1, function: { arguments: '{"path":"a"}' } }] }) +
          chatChunk({}, "tool_calls", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }) +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });
    const { text } = await runChat({
      apiKey: "session-flip-identity",
      body: {
        tools: [{ type: "function", function: { name: "exec_command", description: "run", parameters: { type: "object", properties: {} } } }],
      },
    });
    // Structural check (arguments are JSON-escaped inside the SSE payload):
    // the surviving tool-call deltas must contain the client tool's name and
    // both of its deltas (empty-args opener + argument fragment), and none of
    // the decoy's.
    const deltas = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => {
        try { return JSON.parse(l.slice(6)); } catch { return null; }
      })
      .filter(Boolean);
    const callDeltas = deltas.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || []);
    const names = callDeltas.map((t) => t.function?.name).filter(Boolean);
    expect(names).toContain("exec_command");
    expect(names).not.toContain("bash");
    const args = callDeltas.map((t) => t.function?.arguments);
    expect(args).toContain('{"path":"a"}');
    expect(args.join("")).not.toContain("evil");
    expect(text).toContain("[DONE]");
  });

  // A.1.1 §4: Responses frames fragmented across network chunks — event and
  // data lines split mid-frame must still pair, filter, and never orphan.
  it("fragmented Responses frames: decoy items dropped, event/data pairing intact", async () => {
    h.fetchMock.mockImplementation(async (url, opts) => {
      CALLS.push({ url: String(url), headers: { ...(opts?.headers || {}) }, body: JSON.parse(opts.body) });
      return new Response(chunkedSSE(responsesSSEWithTools(), 9), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const { text } = await runChat({
      model: "opencode/muse-spark-1.3-contributor-free",
      apiKey: "session-flip-identity",
      url: "http://localhost:62198/v1/responses",
      body: {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        messages: undefined,
        tools: [{ type: "function", name: "exec_command", description: "run", parameters: { type: "object", properties: {} } }],
      },
    });
    expect(text).toContain("exec_command");
    expect(text).not.toMatch(/"name"\s*:\s*"bash"/);
    expect(text).not.toMatch(/event:[^\n]+\n(?!data:)/);
    // Terminal still arrives (restoration of the completed response).
    expect(text).toContain("response.completed");
  });
});

describe("gap 4 — forced-SSE deadlines, cancellation, truncation", () => {
  // Scenario 12
  it("forced-SSE normal completion returns JSON with usage; decoy tool call stripped", async () => {
    h.fetchMock.mockImplementation(async (url, opts) => {
      CALLS.push({ url: String(url), headers: { ...(opts?.headers || {}) }, body: JSON.parse(opts.body) });
      return new Response(chatSSEWithTools(), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const result = await handleChatCore(
      baseChatCoreArgs({
        clientStream: false,
        clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: {} },
      })
    );
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("hello world");
    expect(json.usage?.total_tokens).toBe(8);
    const names = (json.choices[0].message.tool_calls || []).map((t) => t.function.name);
    expect(names).toContain("exec_command");
    expect(names).not.toContain("bash");
  });

  function forcedArgs(body, extra = {}) {
    return {
      sourceFormat: "openai",
      targetFormat: "openai",
      provider: "opencode",
      model: "big-pickle",
      body,
      stream: true,
      connectionId: undefined,
      apiKey: "sk-sse",
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
      onRequestSuccess: vi.fn(),
      customToolNames: null,
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      reqTag: "t",
      log: null,
      requestStartTime: nowMs(),
      ...extra,
    };
  }

  // Scenario 13 — chat branch first-chunk deadline
  it(
    "first-chunk timeout → bounded 504 error, reader released",
    async () => {
      const stream = neverStream();
      const providerResponse = new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      const t0 = nowMs();
      const result = await handleForcedSSEToJson(
        forcedArgs({ stream: false }, { providerResponse, timeoutOptions: { firstChunkTimeoutMs: 60, idleTimeoutMs: 60_000 } })
      );
      const elapsed = nowMs() - t0;
      expect(result.success).toBe(false);
      expect(result.status).toBe(504);
      expect(elapsed).toBeLessThan(1200);
      expect(stream.locked).toBe(false);
    },
    1500
  );

  // Scenario 14 — converter idle-stall deadline
  it(
    "idle stall mid-stream → bounded 504 error, reader released",
    async () => {
      const stream = stallAfterOneEvent();
      const providerResponse = { headers: { get: () => "text/event-stream" }, body: stream };
      const t0 = nowMs();
      const result = await handleForcedSSEToJson(
        forcedArgs(
          { stream: false },
          {
            providerResponse,
            targetFormat: "openai-responses",
            timeoutOptions: { firstChunkTimeoutMs: 60_000, idleTimeoutMs: 60 },
          }
        )
      );
      const elapsed = nowMs() - t0;
      expect(result.success).toBe(false);
      expect(result.status).toBe(504);
      expect(elapsed).toBeLessThan(1200);
      expect(stream.locked).toBe(false);
    },
    1500
  );

  // Scenario 15 — downstream cancellation
  it(
    "client abort → request aborted (499), reader released",
    async () => {
      const stream = neverStream();
      const providerResponse = { headers: { get: () => "text/event-stream" }, body: stream };
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 30);
      const t0 = nowMs();
      const result = await handleForcedSSEToJson(
        forcedArgs(
          { stream: false },
          {
            providerResponse,
            targetFormat: "openai-responses",
            signal: ctrl.signal,
            timeoutOptions: { firstChunkTimeoutMs: 60_000, idleTimeoutMs: 60_000 },
          }
        )
      );
      const elapsed = nowMs() - t0;
      expect(result.success).toBe(false);
      expect(result.status).toBe(499);
      expect(elapsed).toBeLessThan(1200);
      expect(stream.locked).toBe(false);
    },
    1500
  );

  // Scenario 16 — EOF without terminal event must not be reported as success
  it("truncated Responses stream → 502 error, never a success payload", async () => {
    const stream = truncatedResponsesStream();
    const providerResponse = { headers: { get: () => "text/event-stream" }, body: stream };
    const result = await handleForcedSSEToJson(
      forcedArgs(
        { stream: false },
        {
          providerResponse,
          targetFormat: "openai-responses",
          timeoutOptions: { firstChunkTimeoutMs: 60_000, idleTimeoutMs: 60_000 },
        }
      )
    );
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(stream.locked).toBe(false);
  });

  // A.1.1 §5: upstream stream errors mid-read → bounded 502, never success,
  // reader released (deadlineErrorResult returns null for non-deadline
  // errors → sseToJsonHandler's generic 502 fallback).
  it("network error mid-stream → bounded 502 error, reader released", async () => {
    const enc = new TextEncoder();
    let n = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (n++ === 0) {
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          return;
        }
        controller.error(new Error("ECONNRESET"));
      },
    });
    const providerResponse = { headers: { get: () => "text/event-stream" }, body: stream };
    const t0 = nowMs();
    const result = await handleForcedSSEToJson(
      forcedArgs({ stream: false }, { providerResponse, timeoutOptions: { firstChunkTimeoutMs: 60_000, idleTimeoutMs: 60_000 } })
    );
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(nowMs() - t0).toBeLessThan(1200);
    expect(stream.locked).toBe(false);
  }, 1500);

  // A.1.1 §5: a long stream whose chunks keep arriving inside the idle window
  // must NOT be failed by the deadline — the idle timer resets per chunk, so
  // total duration > idleTimeoutMs is fine. The post-success wait lets any
  // stray un-cleared timer surface as an unhandled rejection (vitest fails on
  // those), covering timer cleanup.
  it("bytes still arriving reset the idle deadline — long streams succeed", async () => {
    const text = chatSSEWithTools();
    const enc = new TextEncoder();
    const parts = 4;
    const gapMs = 50;
    const slice = Math.ceil(text.length / parts);
    let i = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        if (i >= parts) {
          controller.close();
          return;
        }
        await new Promise((r) => setTimeout(r, gapMs));
        controller.enqueue(enc.encode(text.slice(i * slice, (i + 1) * slice)));
        i += 1;
      },
    });
    const providerResponse = { headers: { get: () => "text/event-stream" }, body: stream };
    const t0 = nowMs();
    const result = await handleForcedSSEToJson(
      forcedArgs(
        { stream: false },
        {
          providerResponse,
          timeoutOptions: { firstChunkTimeoutMs: 60_000, idleTimeoutMs: 100 },
          // Production passes the executor-prepared credentials; the chat
          // branch strips injected decoys post-assembly via this set.
          credentials: { _opencodeDecoyNames: ["bash", "read"] },
        }
      )
    );
    const elapsed = nowMs() - t0;
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("hello world");
    expect(json.usage?.total_tokens).toBe(8);
    const names = (json.choices[0].message.tool_calls || []).map((t) => t.function.name);
    expect(names).toContain("exec_command");
    expect(names).not.toContain("bash");
    // Stream ran longer than idleTimeoutMs (4 x 50ms gaps) — deadline must
    // have been reset by each arriving chunk, not fired at t=100ms.
    expect(elapsed).toBeGreaterThanOrEqual(180);
    // Wait past the idle window: no late timeout may fire post-completion.
    await new Promise((r) => setTimeout(r, 150));
    expect(result.success).toBe(true);
    expect(stream.locked).toBe(false);
  }, 3000);
});
