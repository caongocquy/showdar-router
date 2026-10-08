// Phase B.2: terminal/usage regression tests (task cases A–P).
// Contract: exactly one terminal per Responses stream; transport failures never
// append a second one; real usage always beats estimates on the wire and in
// accounting; every translated Responses stream ends with an explicit terminal.
// Integration cases use the production pipeWithDisconnect shape, not manual
// writer-only mocks.
import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";
import { pipeWithDisconnect, createStreamController } from "../../open-sse/utils/streamHandler.js";
import { buildAbortedResponsesTerminalBytes } from "../../open-sse/utils/responsesStreamHelpers.js";
import { mergeUsage } from "../../open-sse/utils/usageTracking.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const TERMINALS = ["response.completed", "response.done", "response.incomplete", "response.failed"];

const chat = (o) => `data: ${JSON.stringify(o)}\n\n`;
const frame = (evt, o) => `event: ${evt}\ndata: ${JSON.stringify(o)}\n\n`;
const DONE = "data: [DONE]\n\n";

const contentChunk = (id, text) =>
  chat({ id, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
const finishChunk = (id, usage) => {
  const o = { id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  if (usage) o.usage = usage;
  return chat(o);
};
const usageChunk = (id, usage) => chat({ id, choices: [], usage });
const toolPartialChunk = (id) =>
  chat({
    id,
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec", arguments: '{"cmd": "l' } }],
        finish_reason: null,
      },
    }],
  });

async function readAll(stream) {
  const reader = stream.getReader();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text + dec.decode();
}

function parseEvents(output) {
  const events = [];
  let cur = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("event: ")) cur = line.slice(7).trim();
    else if (line.startsWith("data: ") && line.includes("{")) {
      if (cur) events.push({ event: cur, data: JSON.parse(line.slice(6)) });
      cur = null;
    }
  }
  return events;
}

function terminalsOf(output) {
  return parseEvents(output).filter((e) => TERMINALS.includes(e.event));
}

// Production shape: provider body → pipeWithDisconnect → client.
async function runPipe(transform, chunks, opts = {}) {
  const {
    onAbortTerminal = buildAbortedResponsesTerminalBytes,
    stallTimeoutMs = 60000,
    errorAfterMs = null,
    honorAbort = false,
    provider = "openai",
  } = opts;
  const controller = createStreamController({ provider, model: "m" });
  const body = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      if (honorAbort) {
        controller.signal.addEventListener("abort", () => {
          try { c.error(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })); } catch { /* already closed */ }
        });
      } else if (errorAfterMs != null) {
        setTimeout(() => { try { c.error(new Error("ECONNRESET")); } catch { /* already closed */ } }, errorAfterMs);
      } else {
        c.close();
      }
    },
  });
  const client = pipeWithDisconnect({ body }, transform, controller, onAbortTerminal, stallTimeoutMs);
  return readAll(client);
}

// Chat provider → Responses client (translate mode)
async function runTranslate(chunks, opts = {}) {
  const { onStreamComplete = null, ...rest } = opts;
  const ts = createSSETransformStreamWithLogger(
    FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "openai", null, null, "gpt-4o", "conn-1",
    { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    onStreamComplete,
  );
  return runPipe(ts, chunks, rest);
}

// True passthrough (what buildTransformStream picks for equal formats)
async function runPassthrough(chunks, opts = {}) {
  const { onStreamComplete = null, ...rest } = opts;
  const ts = createPassthroughStreamWithLogger(
    "openai", null, "gpt-4o", "conn-1",
    { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
    onStreamComplete,
  );
  return runPipe(ts, chunks, rest);
}

const REAL_USAGE = { prompt_tokens: 111, completion_tokens: 5, total_tokens: 116 };

describe("B.2 A–D: terminal exclusivity across transport failures", () => {
  it("A. translated Responses completes, then transport fails → exactly one response.completed", async () => {
    const output = await runTranslate(
      [contentChunk("cmpl-a", "hello"), finishChunk("cmpl-a", { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })],
      { errorAfterMs: 5 },
    );
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.completed");
    expect(output).not.toContain("response.failed");
  });

  it("B. translated stream fails before terminal (premature EOF) → exactly one response.failed", async () => {
    const output = await runTranslate([contentChunk("cmpl-b", "partial answer")]);
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.failed");
    expect(output).toContain("data: [DONE]");
    // preserved content still reached the client
    expect(output).toContain("partial answer");
  });

  it("C. passthrough completed, then transport fails → no extra failed event", async () => {
    const completed = frame("response.completed", {
      type: "response.completed",
      response: { id: "resp_pt", object: "response", created_at: 1, status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 2 } },
    });
    const output = await runPassthrough(
      [
        frame("response.created", { type: "response.created", response: { id: "resp_pt", object: "response", created_at: 1, status: "in_progress", output: [] } }),
        completed,
      ],
      { errorAfterMs: 5 },
    );
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.completed");
    expect(output).not.toContain("response.failed");
  });

  it("D. native response.incomplete passthrough → exactly one response.incomplete", async () => {
    const output = await runPassthrough([
      frame("response.incomplete", {
        type: "response.incomplete",
        response: {
          id: "resp_native",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ type: "message", id: "msg_n", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "cut off", annotations: [] }] }],
          usage: { input_tokens: 30, output_tokens: 12 },
        },
      }),
    ]);
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.incomplete");
    expect(output).not.toContain("response.completed");
    expect(output).not.toContain("response.failed");
    expect(t[0].data.response.usage.input_tokens).toBe(30);
  });
});

describe("B.2 E–I: real usage authority on the terminal", () => {
  it("E. finish without usage + trailing real usage → terminal carries the real usage", async () => {
    const output = await runTranslate([
      contentChunk("cmpl-e", "hi"),
      finishChunk("cmpl-e"),
      usageChunk("cmpl-e", REAL_USAGE),
      DONE,
    ]);
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.completed");
    expect(t[0].data.response.usage.input_tokens).toBe(111);
    expect(t[0].data.response.usage.output_tokens).toBe(5);
    expect(t[0].data.response.usage.estimated).toBeUndefined();
  });

  it("F. mergeUsage: estimate never beats real regardless of magnitude", () => {
    const estimate = { prompt_tokens: 2012, completion_tokens: 500, total_tokens: 2512, estimated: true };
    const real = { prompt_tokens: 111, completion_tokens: 5, total_tokens: 116 };
    expect(mergeUsage(estimate, real)).toEqual(real);
    expect(mergeUsage(real, estimate).prompt_tokens).toBe(111);
    // equal authority keeps numeric max-merge
    expect(mergeUsage({ prompt_tokens: 10 }, { prompt_tokens: 7 }).prompt_tokens).toBe(10);
  });

  it("F2. estimated usage larger than real → real wins on the wire", async () => {
    const longContent = "x".repeat(4000); // would estimate to far more than 111 output tokens
    const output = await runTranslate([
      contentChunk("cmpl-f", longContent),
      finishChunk("cmpl-f"),
      usageChunk("cmpl-f", REAL_USAGE),
      DONE,
    ]);
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].data.response.usage.input_tokens).toBe(111);
    expect(t[0].data.response.usage.output_tokens).toBe(5);
    expect(t[0].data.response.usage.estimated).toBeUndefined();
  });

  it("G. real usage arrives after finish_reason → accounting records the real usage", async () => {
    const completions = [];
    const output = await runTranslate(
      [contentChunk("cmpl-g", "hi"), finishChunk("cmpl-g"), usageChunk("cmpl-g", REAL_USAGE), DONE],
      { onStreamComplete: (content, usage) => completions.push({ content, usage }) },
    );
    expect(terminalsOf(output)).toHaveLength(1);
    expect(completions).toHaveLength(1);
    expect(completions[0].usage.prompt_tokens).toBe(111);
    expect(completions[0].usage.estimated).toBeFalsy();
  });

  it("H. no real usage at genuine EOF → estimate is allowed", async () => {
    const output = await runTranslate([contentChunk("cmpl-h", "some answer"), finishChunk("cmpl-h"), DONE]);
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.completed");
    expect(t[0].data.response.usage).toBeTruthy();
    expect(t[0].data.response.usage.estimated).toBe(true);
    expect(t[0].data.response.usage.input_tokens).toBeGreaterThan(0);
  });

  it("I. finish → trailing usage → [DONE]: terminal ordering is correct", async () => {
    const output = await runTranslate([
      contentChunk("cmpl-i", "hi"),
      finishChunk("cmpl-i"),
      usageChunk("cmpl-i", REAL_USAGE),
      DONE,
    ]);
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.completed");
    expect(t[0].data.response.usage.input_tokens).toBe(111);
    // the terminal is the last event; no failure appended after it
    expect(output).not.toContain("response.failed");
    const terminalIdx = output.indexOf("event: response.completed");
    const lastEventIdx = output.lastIndexOf("event: ");
    expect(terminalIdx).toBe(lastEventIdx);
  });
});

describe("B.2 J–N: explicit termination, no double [DONE], accounting once", () => {
  it("J. [DONE] without finish_reason → explicit response.failed, not bare EOF", async () => {
    const output = await runTranslate([contentChunk("cmpl-j", "hello world"), DONE]);
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.failed");
    // failed precedes the forwarded [DONE]
    expect(output.indexOf("event: response.failed")).toBeLessThan(output.indexOf("data: [DONE]"));
    // preserved content
    expect(output).toContain("hello world");
    // single [DONE]
    expect(output.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("K. network reset before terminal → exactly one response.failed", async () => {
    const output = await runTranslate([contentChunk("cmpl-k", "hi")], { errorAfterMs: 5 });
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.failed");
    expect(output).toContain("data: [DONE]");
  });

  it("L. stall before terminal → response.failed, bounded wait (no infinite hang)", async () => {
    const t0 = Date.now();
    const output = await runTranslate([contentChunk("cmpl-l", "hi")], { stallTimeoutMs: 50, honorAbort: true });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(3000);
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.failed");
  });

  it("M. failure after terminal → no additional response.failed", async () => {
    const output = await runTranslate(
      [contentChunk("cmpl-m", "hi"), finishChunk("cmpl-m", { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }), DONE],
      { errorAfterMs: 5 },
    );
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.completed");
    expect(output).not.toContain("response.failed");
    expect(output.match(/data: \[DONE\]/g) ?? []).toHaveLength(0);
  });

  it("N. client closes right after the terminal → accounting exactly once", async () => {
    const completions = [];
    const ts = createSSETransformStreamWithLogger(
      FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "openai", null, null, "gpt-4o", "conn-1",
      { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      (content, usage) => completions.push({ content, usage }),
    );
    const controller = createStreamController({ provider: "openai", model: "m" });
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(contentChunk("cmpl-n", "hi")));
        c.enqueue(enc.encode(finishChunk("cmpl-n", { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 })));
        c.enqueue(enc.encode(DONE));
        c.close();
      },
    });
    const client = pipeWithDisconnect({ body }, ts, controller, buildAbortedResponsesTerminalBytes, 60000);
    const reader = client.getReader();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes("event: response.completed")) {
        await reader.cancel();
        break;
      }
    }
    expect(completions).toHaveLength(1);
    expect(completions[0].usage.prompt_tokens).toBe(5);
    expect(terminalsOf(buf)).toHaveLength(1);
  });
});

describe("B.2 O–P: synthetic identity + partial tool safety", () => {
  it("O. synthesized response.failed reuses the active response ID", async () => {
    const output = await runTranslate([contentChunk("cmpl-o", "hello"), DONE]);
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.failed");
    const created = parseEvents(output).find((e) => e.event === "response.created");
    expect(created).toBeTruthy();
    expect(t[0].data.response.id).toBe(created.data.response.id);
    expect(t[0].data.response.id).not.toMatch(/^resp_\d+$/);
  });

  it("P. partial tool call interrupted at EOF → never reported as successful completion", async () => {
    const output = await runTranslate([toolPartialChunk("cmpl-p")]);
    const t = terminalsOf(output);
    expect(t).toHaveLength(1);
    expect(t[0].event).toBe("response.failed");
    const events = parseEvents(output);
    expect(events.filter((e) => e.event === "response.completed")).toHaveLength(0);
    // the truncated function_call item must not be closed as completed
    const funcDone = events.find(
      (e) => e.event === "response.output_item.done" && e.data.item?.type === "function_call",
    );
    expect(funcDone).toBeUndefined();
    expect(output).toContain("data: [DONE]");
  });
});
