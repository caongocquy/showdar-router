#!/usr/bin/env node
/**
 * SR-07 — client & local provider integration smoke.
 *
 * Boots the real standalone router over loopback with an isolated DATA_DIR and
 * a controlled OpenAI-compatible fake upstream, then exercises the public HTTP
 * boundary (OpenAI Chat Completions): JSON, SSE, tool calls, 429 fallback,
 * prefill/stall timeouts, client cancellation, capability filtering and the
 * sanitized latency trace.
 *
 * Isolation:
 *  - temp DATA_DIR (config/DB/keys never touch the user's install),
 *  - ephemeral loopback ports for router + upstream,
 *  - no network beyond 127.0.0.1, no paid providers, no credentials.
 *
 * Usage:
 *   npm run test:integration:routing
 *   STANDALONE_SMOKE_SKIP_BUILD=1 npm run test:integration:routing
 *
 * Optional isolated OpenCode CLI probe (H; needs `opencode` on PATH):
 *   SHOWDAR_ROUTER_OPENCODE_SMOKE=1 npm run test:integration:routing
 *
 * Optional manual remote local-provider probe (never runs in CI):
 *   SHOWDAR_ROUTER_REMOTE_SMOKE_BASE_URL=http://<host>:<port>/v1 \
 *   SHOWDAR_ROUTER_REMOTE_SMOKE_MODEL=<model> node scripts/routing-integration-smoke.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createProbeServer } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = process.env.NEXT_DIST_DIR || ".next";
const standaloneDir = join(repo, distDir, "standalone");
const customServerPath = join(standaloneDir, "custom-server.js");
const skipBuild = process.env.STANDALONE_SMOKE_SKIP_BUILD === "1";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const TRACE_PREFIX = "[showdar-latency] ";
const PASSED = [];

let child = null;
let childExit = null;
let childLogs = "";
let upstream = null;
let dataDir = null;

function pass(id, detail) {
  PASSED.push(id);
  console.log(`PASS ${id}${detail ? ` — ${detail}` : ""}`);
}

function freePort() {
  return new Promise((res, rej) => {
    const probe = createProbeServer();
    probe.once("error", rej);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((err) => (err ? rej(err) : res(port)));
    });
  });
}

function assertArtifacts() {
  for (const p of [customServerPath, join(standaloneDir, distDir, "static"), join(standaloneDir, "public")]) {
    if (!existsSync(p)) {
      throw new Error(`[missing-artifact] ${p} — run npm run build first (or unset STANDALONE_SMOKE_SKIP_BUILD)`);
    }
  }
}

// ---- fake upstream ---------------------------------------------------------

const upstreamState = { requests: [], nextId: 0 };

const sseStart = (res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
};
const writeEvent = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

function chunkBase(model, id) {
  return { id, object: "chat.completion.chunk", created: 1, model, choices: [] };
}

function startSse(res, model, id) {
  sseStart(res);
  writeEvent(res, {
    ...chunkBase(model, id),
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });
}

function endSse(res, model, id, finishReason = "stop") {
  writeEvent(res, {
    ...chunkBase(model, id),
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function jsonCompletion(res, model, { content = "ok", toolCalls = null, finishReason = "stop" } = {}) {
  const message = { role: "assistant", content: toolCalls ? null : content };
  if (toolCalls) message.tool_calls = toolCalls;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "chatcmpl-upstream",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }));
}

function streamText(res, model, id, text) {
  startSse(res, model, id);
  writeEvent(res, {
    ...chunkBase(model, id),
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });
  endSse(res, model, id);
}

function streamToolCalls(res, model) {
  const id = "chatcmpl-tool-1";
  startSse(res, model, id);
  writeEvent(res, {
    ...chunkBase(model, id),
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_weather_1",
          type: "function",
          function: { name: "get_weather", arguments: "" },
        }],
      },
      finish_reason: null,
    }],
  });
  writeEvent(res, {
    ...chunkBase(model, id),
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }],
  });
  writeEvent(res, {
    ...chunkBase(model, id),
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: null }],
  });
  endSse(res, model, id, "tool_calls");
}

upstream = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* malformed fixture */ }
    const model = String(body.model || "");
    if (process.env.SR07_DEBUG) console.log(`[fixture] model=${model} stream=${!!body.stream} accept=${req.headers.accept || ""}`);
    const record = { model, path: req.url, stream: !!body.stream, closed: false, startedAt: Date.now() };
    upstreamState.requests.push(record);
    res.once("close", () => { record.closed = true; });

    const id = `chatcmpl-fixture-${++upstreamState.nextId}`;

    if (model === "rate-limited") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "600" });
      res.end(JSON.stringify({ error: { message: "fixture rate limit", type: "rate_limit_error" } }));
      return;
    }
    if (model.startsWith("slow-headers")) {
      await delay(1500);
      if (res.destroyed) return;
      if (body.stream) streamText(res, model, id, "late headers");
      else jsonCompletion(res, model, { content: "late headers" });
      return;
    }
    if (model === "delayed-first-chunk") {
      // Commit the SSE role frame, then stall before the first content delta.
      startSse(res, model, id);
      await delay(1500);
      if (res.destroyed) return;
      writeEvent(res, {
        ...chunkBase(model, id),
        choices: [{ index: 0, delta: { content: "late token" }, finish_reason: null }],
      });
      endSse(res, model, id);
      return;
    }
    if (model === "silent-prefill") {
      sseStart(res);
      // Never send content — the combo first-meaningful deadline must fire.
      return;
    }
    if (model === "stall-after-content") {
      startSse(res, model, id);
      writeEvent(res, {
        ...chunkBase(model, id),
        choices: [{ index: 0, delta: { content: "first chunk" }, finish_reason: null }],
      });
      // Keep the connection open so the inter-chunk stall policy fires.
      return;
    }
    if (model === "slow-progress") {
      startSse(res, model, id);
      for (let i = 0; i < 6; i++) {
        await delay(180);
        if (res.destroyed) return;
        writeEvent(res, {
          ...chunkBase(model, id),
          choices: [{ index: 0, delta: { content: `t${i}` }, finish_reason: null }],
        });
      }
      endSse(res, model, id);
      return;
    }
    if (model === "tool-model") {
      if (body.stream) {
        streamToolCalls(res, model);
      } else {
        jsonCompletion(res, model, {
          toolCalls: [{
            id: "call_weather_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          }],
          finishReason: "tool_calls",
        });
      }
      return;
    }
    // "text-model", "gpt-4o" and anything else answer normally.
    if (body.stream) streamText(res, model, id, "hello from local fixture");
    else jsonCompletion(res, model, { content: "hello from local fixture" });
  });
});

// ---- SSE client helpers ----------------------------------------------------

async function readSse(res, { signal } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      if (signal?.aborted) break;
    }
  } catch { /* aborted or upstream error */ }
  const events = raw.split("\n\n").map((b) => b.trim()).filter(Boolean);
  const data = events.filter((e) => e.startsWith("data: ")).map((e) => e.slice(6).trim());
  const doneCount = data.filter((d) => d === "[DONE]").length;
  const chunks = data.filter((d) => d !== "[DONE]").map((d) => {
    try { return JSON.parse(d); } catch { return null; }
  }).filter(Boolean);
  return { raw, events, chunks, doneCount };
}

const contentOf = (chunks) => chunks
  .flatMap((c) => (c.choices || []).map((ch) => ch.delta?.content || ""))
  .join("");

const finishReasons = (chunks) => chunks
  .flatMap((c) => (c.choices || []).map((ch) => ch.finish_reason))
  .filter(Boolean);

// ---- router boot -----------------------------------------------------------

async function waitReady(port) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (childExit) {
      throw new Error(`[startup-failure] server exited (code=${childExit.code})\n${childLogs}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) return;
    } catch { /* still starting */ }
    await delay(150);
  }
  throw new Error(`[startup-failure] /api/health not ready within 40s\n${childLogs}`);
}

async function stopChild() {
  if (!child || childExit) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 60 && !childExit; i++) await delay(100);
  if (!childExit) {
    child.kill("SIGKILL");
    for (let i = 0; i < 20 && !childExit; i++) await delay(100);
  }
}

function emergencyStop() {
  if (child && !childExit) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  if (upstream) {
    try { upstream.close(); } catch { /* already closed */ }
  }
}
process.once("SIGINT", () => { emergencyStop(); process.exit(130); });
process.once("SIGTERM", () => { emergencyStop(); process.exit(143); });

// ---- harness ---------------------------------------------------------------

let base = "";
let apiKey = "";

async function api(path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-9r-cli-token": harnessToken },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  assert.equal(res.status, 201, `POST ${path} failed: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function patchApi(path, body) {
  const res = await fetch(base + path, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-9r-cli-token": harnessToken },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  assert.equal(res.status, 200, `PATCH ${path} failed: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function chat(body, { signal = AbortSignal.timeout(15_000) } = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
}

const user = (content = "hi") => [{ role: "user", content }];
const modelOf = (nodeId, name) => `${nodeId}/${name}`;

let harnessToken = "";

// ---- scenarios -------------------------------------------------------------

async function scenarioA(node) {
  const res = await chat({ model: "sr07-basic", messages: user("A"), stream: false });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /application\/json/);
  const json = await res.json();
  assert.equal(json.object, "chat.completion");
  assert.equal(json.choices.length, 1);
  assert.equal(json.choices[0].message.role, "assistant");
  assert.equal(json.choices[0].message.content, "hello from local fixture");
  assert.equal(json.choices[0].finish_reason, "stop");
  assert.ok(typeof json.model === "string" && json.model.length > 0, "response model must be set");
  assert.equal(json.model, "text-model", "response model reflects the served upstream model");
  const calls = upstreamState.requests.filter((r) => r.model === "text-model");
  assert.equal(calls.length, 1, "exactly one upstream completion");
  pass("A", "non-streaming JSON completion");
}

async function scenarioB() {
  const res = await chat({ model: "sr07-basic", messages: user("B"), stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const { chunks, doneCount, events } = await readSse(res);
  assert.equal(doneCount, 1, "exactly one [DONE]");
  assert.equal(events.at(-1), "data: [DONE]", "DONE is the terminal event");
  const ids = new Set(chunks.map((c) => c.id));
  assert.equal(ids.size, 1, "stable completion identity");
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  assert.equal(contentOf(chunks), "hello from local fixture");
  assert.deepEqual(finishReasons(chunks), ["stop"]);
  pass("B", "streaming SSE framing and identity");
}

async function scenarioC() {
  // Streaming tool-call deltas.
  const streamRes = await chat({ model: "sr07-tools", messages: user("C"), stream: true, tools: [{ type: "function", function: { name: "get_weather" } }] });
  assert.equal(streamRes.status, 200);
  const { chunks, doneCount } = await readSse(streamRes);
  assert.equal(doneCount, 1, "one [DONE] for tool-call streams");
  const toolDeltas = chunks.flatMap((c) => (c.choices || []).flatMap((ch) => ch.delta?.tool_calls || []));
  assert.ok(toolDeltas.length >= 2, "tool-call deltas arrive incrementally");
  const callIds = new Set(toolDeltas.map((t) => t.id).filter(Boolean));
  assert.deepEqual([...callIds], ["call_weather_1"], "stable tool-call id");
  const names = new Set(toolDeltas.map((t) => t.function?.name).filter(Boolean));
  assert.deepEqual([...names], ["get_weather"], "stable function name");
  const args = toolDeltas.map((t) => t.function?.arguments || "").join("");
  assert.deepEqual(JSON.parse(args), { city: "Paris" });
  assert.deepEqual(finishReasons(chunks), ["tool_calls"]);

  // Non-streaming tool-call response.
  const jsonRes = await chat({ model: "sr07-tools", messages: user("C2"), stream: false });
  assert.equal(jsonRes.status, 200);
  const json = await jsonRes.json();
  const toolCalls = json.choices[0].message.tool_calls;
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].id, "call_weather_1");
  assert.equal(toolCalls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { city: "Paris" });
  assert.equal(json.choices[0].finish_reason, "tool_calls");
  pass("C", "streaming + non-streaming tool calls");
}

async function scenarioD() {
  const before = upstreamState.requests.length;
  const started = Date.now();
  const res = await chat({ model: "sr07-fallback", messages: user("TRACE_CANARY_SR07_9f3"), stream: false });
  assert.equal(res.status, 200);
  const json = await res.json();
  const elapsed = Date.now() - started;
  assert.equal(json.choices[0].message.content, "hello from local fixture");
  assert.ok(elapsed < 5000, `fallback must not wait out Retry-After (took ${elapsed}ms)`);
  const dispatched = upstreamState.requests.slice(before);
  assert.deepEqual(dispatched.map((r) => r.model), ["rate-limited", "text-model"], "ordered dispatch, no duplicates");
  assert.equal(dispatched.filter((r) => r.model === "rate-limited").length, 1);

  // Cooldown took effect: the second request must skip candidate A entirely.
  await delay(100);
  const beforeSecond = upstreamState.requests.length;
  const second = await chat({ model: "sr07-fallback", messages: user("D2"), stream: false });
  assert.equal(second.status, 200);
  await second.json();
  const secondDispatch = upstreamState.requests.slice(beforeSecond).map((r) => r.model);
  assert.deepEqual(secondDispatch, ["text-model"], "cooled candidate is skipped on the next request");

  // Sanitized trace explains the first fallback without leaking the prompt or key.
  await delay(100);
  const traceLines = childLogs.split("\n").filter((l) => l.startsWith(TRACE_PREFIX));
  const trace = traceLines
    .map((l) => { try { return JSON.parse(l.slice(TRACE_PREFIX.length)); } catch { return null; } })
    .filter(Boolean)
    .find((p) => p.combo?.name === "sr07-fallback" && p.attempts?.length === 2 && p.attempts[0].reason === "rate_limited");
  assert.ok(trace, "fallback request emitted a diagnosable trace");
  assert.ok(trace.attempts[0].status >= 400, "failed attempt records an error status");
  assert.equal(trace.attempts[0].reason, "rate_limited");
  assert.equal(trace.attempts[1].result, "success");
  assert.equal(trace.winner?.type, "FALLBACK_WINNER");
  assert.ok(!JSON.stringify(trace).includes("TRACE_CANARY_SR07_9f3"), "trace must not leak prompt text");
  assert.ok(!JSON.stringify(trace).includes(apiKey), "trace must not leak the router API key");

  // The cooldown is diagnosable: the next trace marks candidate A as skipped.
  const cooled = traceLines
    .map((l) => { try { return JSON.parse(l.slice(TRACE_PREFIX.length)); } catch { return null; } })
    .filter(Boolean)
    .find((p) => p.combo?.name === "sr07-fallback" && p.candidates?.[0]?.healthSkip === true);
  assert.ok(cooled, "cooldown metadata is recorded in the trace");
  pass("D", `429 fallback in ${elapsed}ms, cooldown + sanitized trace verified`);
}

async function scenarioE() {
  // E1: connection timeout — upstream never sends headers.
  let started = Date.now();
  const e1 = await chat({ model: "sr07-slow-headers", messages: user("E1"), stream: false });
  assert.ok(e1.status >= 500, `connect timeout should fail, got ${e1.status}`);
  const e1Text = await e1.text();
  const e1Elapsed = Date.now() - started;
  // The 500ms connect deadline fires first; provider retry backoff (502: 3x3s)
  // legitimately extends the wall time, so assert the configured deadline itself.
  assert.match(`${e1Text}\n${childLogs}`, /fetch connect timeout/);
  assert.ok(e1Elapsed < 20000, `connect timeout total ${e1Elapsed}ms exceeded retry budget`);

  // E2: first-meaningful prefill deadline inside combo validation → fallback.
  started = Date.now();
  const e2 = await chat({ model: "sr07-prefill", messages: user("E2"), stream: true });
  assert.equal(e2.status, 200);
  const e2Sse = await readSse(e2);
  const e2Elapsed = Date.now() - started;
  assert.equal(contentOf(e2Sse.chunks), "hello from local fixture");
  assert.ok(e2Elapsed < 5000, `first-meaningful deadline fired in ${e2Elapsed}ms`);

  // E3: inter-chunk stall ends the stream, and it never emits a fake [DONE].
  started = Date.now();
  const e3 = await chat({ model: "sr07-stall", messages: user("E3"), stream: true });
  const e3Sse = await readSse(e3);
  const e3Elapsed = Date.now() - started;
  assert.equal(e3Sse.doneCount, 0, "stalled stream must not emit [DONE]");
  assert.ok(e3Elapsed < 5000, `stall deadline fired in ${e3Elapsed}ms`);

  // E4: a slow but progressing stream outlives every phase deadline → no blanket
  // total request deadline exists.
  started = Date.now();
  const e4 = await chat({ model: "sr07-slow", messages: user("E4"), stream: true });
  const e4Sse = await readSse(e4);
  const e4Elapsed = Date.now() - started;
  assert.equal(e4.status, 200);
  assert.equal(e4Sse.doneCount, 1);
  assert.equal(contentOf(e4Sse.chunks), "t0t1t2t3t4t5");
  assert.ok(e4Elapsed > 1000, `slow progress ran ${e4Elapsed}ms (phase deadlines, not a total cap)`);
  pass("E", `connect ${e1Elapsed}ms, prefill ${e2Elapsed}ms, stall ${e3Elapsed}ms, slow-progress ${e4Elapsed}ms`);
}

async function scenarioF(nodeId) {
  // F1: abort before any response headers.
  let before = upstreamState.requests.length;
  const c1 = new AbortController();
  const p1 = chat({ model: "sr07-slow-headers-f", messages: user("F1"), stream: false }, { signal: c1.signal });
  await delay(250);
  c1.abort();
  let f1Status = null;
  try {
    const r = await p1;
    f1Status = r.status;
    await r.text().catch(() => {});
  } catch (e) {
    assert.match(`${e.name} ${e.message}`, /abort/i);
  }
  await delay(300);
  assert.equal(upstreamState.requests.length - before, 1, "one upstream dispatch, no fallback");
  assert.equal(upstreamState.requests.at(-1).closed, true, "upstream request cancelled");
  if (f1Status !== null) assert.ok(f1Status >= 400, `aborted request must not succeed (got ${f1Status})`);

  // F2: abort after headers but before the first committed chunk.
  before = upstreamState.requests.length;
  const c2 = new AbortController();
  const p2 = chat({ model: modelOf(nodeId, "delayed-first-chunk"), messages: user("F2"), stream: true }, { signal: c2.signal });
  const r2 = await p2;
  assert.equal(r2.status, 200);
  await delay(80);
  c2.abort();
  const f2 = await readSse(r2, { signal: c2.signal });
  assert.equal(f2.doneCount, 0, "no synthetic terminal after abort");
  await delay(250);
  assert.equal(upstreamState.requests.length - before, 1, "no fallback after abort");
  assert.equal(upstreamState.requests.at(-1).closed, true, "upstream closed");

  // F3: abort after first committed content.
  before = upstreamState.requests.length;
  const c3 = new AbortController();
  const p3 = chat({ model: "sr07-slow", messages: user("F3"), stream: true }, { signal: c3.signal });
  const r3 = await p3;
  const reader = r3.body.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes('"content":"t')) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  c3.abort();
  await reader.cancel().catch(() => {});
  let rest = "";
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; rest += decoder.decode(value, { stream: true }); } } catch { /* aborted */ }
  assert.ok(!seen.includes("[DONE]") && !rest.includes("[DONE]"), "no [DONE] after committed abort");
  await delay(250);
  assert.equal(upstreamState.requests.length - before, 1, "no duplicate completion after committed abort");

  // Router survives every cancellation.
  const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
  assert.equal(health.status, 200);
  const after = await chat({ model: "sr07-basic", messages: user("F4"), stream: false });
  assert.equal(after.status, 200);
  pass("F", "pre-header, pre-chunk and post-commit cancellation");
}

async function scenarioG(nodeId) {
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } };

  // Eligible vision candidate: only gpt-4o is dispatched.
  let before = upstreamState.requests.length;
  const ok = await chat({
    model: "sr07-capable",
    messages: [{ role: "user", content: [{ type: "text", text: "describe" }, image] }],
    stream: false,
  });
  assert.equal(ok.status, 200);
  await ok.json();
  const dispatched = upstreamState.requests.slice(before).map((r) => r.model);
  assert.deepEqual(dispatched, ["gpt-4o"], "text-only candidate filtered before dispatch");

  // No eligible candidate: capability failure without any provider dispatch.
  before = upstreamState.requests.length;
  const none = await chat({
    model: "sr07-text-only",
    messages: [{ role: "user", content: [{ type: "text", text: "describe" }, image] }],
    stream: false,
  });
  assert.ok([400, 410, 503].includes(none.status), `unexpected capability failure status ${none.status}`);
  const err = await none.json();
  assert.match(JSON.stringify(err), /vision|capabilit/i);
  assert.equal(upstreamState.requests.length - before, 0, "incompatible provider never dispatched");

  // Advisory capabilities are not hard filters: a web_search tool does not
  // disqualify a text-only candidate.
  before = upstreamState.requests.length;
  const advisory = await chat({
    model: "sr07-text-only",
    messages: user("G3"),
    tools: [{ type: "web_search" }],
    stream: false,
  });
  assert.equal(advisory.status, 200);
  await advisory.json();
  assert.deepEqual(upstreamState.requests.slice(before).map((r) => r.model), ["text-model"]);
  pass("G", "hard modality filtering, no dispatch when ineligible, advisory tools preserved");
}

// ---- isolated OpenCode CLI probe (H) ---------------------------------------

async function opencodeProbe() {
  if (process.env.SHOWDAR_ROUTER_OPENCODE_SMOKE !== "1") {
    console.log("SKIP H.opencode — set SHOWDAR_ROUTER_OPENCODE_SMOKE=1 to execute the isolated CLI probe");
    return;
  }
  let version;
  try {
    version = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    console.log("SKIP H.opencode — opencode CLI not available on PATH");
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "showdar-router-opencode-"));
  try {
    mkdirSync(join(home, "config", "opencode"), { recursive: true });
    // Mirrors the installed v2 schema; everything is temp — the user's config
    // is never read or written.
    writeFileSync(join(home, "config", "opencode", "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "sr07-router/sr07-basic",
      providers: {
        "sr07-router": {
          name: "SR07 Router",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `${base}/v1`, apiKey },
          models: { "sr07-basic": { name: "SR07 Basic" } },
        },
      },
    }, null, 2));
    // OpenCode's private server inherits our pipes and outlives the CLI process,
    // so wait on `exit` (not stdio EOF) to avoid a fake timeout.
    const cli = spawn("opencode", [
      "run", "--standalone", "--model", "sr07-router/sr07-basic",
      "Reply with exactly: hello from local fixture",
    ], {
      cwd: home,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_STATE_HOME: join(home, "state"),
        XDG_CACHE_HOME: join(home, "cache"),
        SHOWDAR_ROUTER_API_KEY: apiKey,
      },
    });
    let out = "";
    let err = "";
    cli.stdout.on("data", (c) => { out += c; });
    cli.stderr.on("data", (c) => { err += c; });
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => { cli.kill("SIGKILL"); resolve({ code: null, timedOut: true }); }, 120_000);
      cli.once("error", (error) => { clearTimeout(timer); resolve({ code: null, error }); });
      cli.once("exit", (code) => { clearTimeout(timer); resolve({ code, timedOut: false }); });
    });
    assert.ok(!result.timedOut && result.code === 0, `OpenCode CLI failed (code=${result.code}): ${err.slice(-500)}`);
    assert.match(out, /hello from local fixture/, "OpenCode output must come from the fixture upstream");
    pass("H", `OpenCode CLI ${version} completed through the router (isolated XDG)`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ---- optional remote local-provider probe ---------------------------------

async function remoteLocalProbe() {
  const url = process.env.SHOWDAR_ROUTER_REMOTE_SMOKE_BASE_URL;
  const model = process.env.SHOWDAR_ROUTER_REMOTE_SMOKE_MODEL;
  if (!url || !model) {
    console.log("SKIP H.remote — set SHOWDAR_ROUTER_REMOTE_SMOKE_BASE_URL and _MODEL to probe a trusted local endpoint");
    return;
  }
  const res = await fetch(url.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.SHOWDAR_ROUTER_REMOTE_SMOKE_API_KEY
        ? { authorization: `Bearer ${process.env.SHOWDAR_ROUTER_REMOTE_SMOKE_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({ model, messages: user("ping"), stream: false }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.choices?.[0]?.message, "remote local endpoint returned a chat completion");
  pass("remote", "opt-in remote local-provider probe");
}

// ---- main ------------------------------------------------------------------

try {
  if (!skipBuild) {
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: repo, stdio: "inherit" });
  }
  assertArtifacts();

  const upstreamPort = await freePort();
  await new Promise((res, rej) => {
    upstream.once("error", rej);
    upstream.listen(upstreamPort, "127.0.0.1", res);
  });

  dataDir = mkdtempSync(join(tmpdir(), "showdar-router-sr07-"));
  mkdirSync(join(dataDir, "auth"), { recursive: true });
  const machineId = randomBytes(16).toString("hex");
  const cliSecret = randomBytes(32).toString("hex");
  writeFileSync(join(dataDir, "machine-id"), machineId);
  writeFileSync(join(dataDir, "auth", "cli-secret"), cliSecret);
  harnessToken = createHash("sha256").update(machineId + "9r-cli-auth" + cliSecret).digest("hex").slice(0, 16);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [customServerPath, "--port", String(port)], {
    cwd: standaloneDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      SHOWDAR_ROUTER_DATA_DIR: dataDir,
      DATA_DIR: dataDir,
      // Phase-specific deadlines only; no total request deadline exists.
      FETCH_CONNECT_TIMEOUT_MS: "500",
      STREAM_STALL_TIMEOUT_MS: "700",
      STREAM_FIRST_CHUNK_TIMEOUT_MS: "700",
      COMBO_FIRST_MEANINGFUL_TIMEOUT_MS: "400",
      ERROR_BODY_READ_TIMEOUT_MS: "600",
      SHOWDAR_ROUTER_LATENCY_TRACE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => { childLogs += c; });
  child.stderr.on("data", (c) => { childLogs += c; });
  child.on("exit", (code, signal) => { childExit = { code, signal }; });
  child.on("error", (error) => { childExit = { code: null, signal: null }; childLogs += `\nspawn error: ${error.message}`; });

  await waitReady(port);

  const node = (await api("/api/provider-nodes", {
    name: "sr07-fixture",
    prefix: "sr07",
    apiType: "chat",
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
  })).node;
  await api("/api/providers", { provider: node.id, apiKey: "fixture", name: "sr07-fixture" });
  apiKey = (await api("/api/keys", { name: "sr07-smoke" })).key;

  // Isolated runs must never reach a real provider: the default vision/audio
  // capacity adapter falls back to a remote model, so disable every pool.
  const disabledPool = { enabled: false, roundRobin: false, models: [] };
  await patchApi("/api/settings", {
    capacityAdapter: { vision: disabledPool, pdf: disabledPool, audioInput: disabledPool, videoInput: disabledPool },
  });

  const combos = {
    "sr07-basic": [modelOf(node.id, "text-model")],
    "sr07-tools": [modelOf(node.id, "tool-model")],
    "sr07-fallback": [modelOf(node.id, "rate-limited"), modelOf(node.id, "text-model")],
    "sr07-slow-headers": [modelOf(node.id, "slow-headers")],
    "sr07-slow-headers-f": [modelOf(node.id, "slow-headers-f")],
    "sr07-delayed": [modelOf(node.id, "delayed-first-chunk")],
    "sr07-prefill": [modelOf(node.id, "silent-prefill"), modelOf(node.id, "text-model")],
    "sr07-stall": [modelOf(node.id, "stall-after-content")],
    "sr07-slow": [modelOf(node.id, "slow-progress")],
    "sr07-capable": [modelOf(node.id, "text-model"), modelOf(node.id, "gpt-4o")],
    "sr07-text-only": [modelOf(node.id, "text-model")],
  };
  for (const [name, models] of Object.entries(combos)) await api("/api/combos", { name, models });

  await scenarioA(node);
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioE();
  await scenarioF(node.id);
  await scenarioG(node.id);
  await opencodeProbe();
  await remoteLocalProbe();

  assert.doesNotMatch(childLogs, /unhandledrejection|uncaughtException/i);
  console.log(`\nrouting integration smoke: PASS (${PASSED.length} scenarios, router ${base}, upstream 127.0.0.1:${upstreamPort})`);
} catch (error) {
  console.error(`\nrouting integration smoke: FAIL\n${error?.stack || error}`);
  if (childLogs) console.error(`\n--- router logs (tail) ---\n${childLogs.split("\n").slice(-40).join("\n")}`);
  process.exitCode = 1;
} finally {
  await stopChild();
  if (upstream) await new Promise((res) => upstream.close(res));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}
