import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  trackPendingRequest: vi.fn(),
}));

import { formatDoneLine } from "../../open-sse/handlers/chatCore/requestDetail.js";
import { buildOnStreamComplete } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

async function consume(stream) {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {}
}

describe("stream finish reason logging", () => {
  it("adds the provider finish reason to the final DONE line", () => {
    expect(formatDoneLine({
      usage: { prompt_tokens: 3, completion_tokens: 4 },
      latency: { total: 12 },
      finishReason: "stop",
    })).toContain(" · FINISH stop");
  });

  it("captures length from the terminal OpenAI chunk even without content", async () => {
    const onComplete = vi.fn();
    const input = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n");
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
        controller.close();
      },
    });

    await consume(source.pipeThrough(createPassthroughStreamWithLogger(
      "openai", null, "gpt-5.5", null, null, onComplete,
    )));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][3]).toBe("length");
  });

  it("warns once for length without changing health through the logger", () => {
    const log = { line: vi.fn(), warn: vi.fn() };
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "openai", model: "gpt-5.5", requestStartTime: Date.now(), body: {}, stream: false, log,
    });

    onStreamComplete({ content: "partial" }, null, null, "length");

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.line.mock.calls[0][2]).toContain("FINISH length");
  });

  it("does not warn or append a finish field when the provider omits it", () => {
    const log = { line: vi.fn(), warn: vi.fn() };
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "openai", model: "gpt-5.5", requestStartTime: Date.now(), body: {}, stream: false, log,
    });

    onStreamComplete({ content: "ok" }, null, null, null);

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.line.mock.calls[0][2]).not.toContain("FINISH");
  });
});

describe("console log copy contract", () => {
  it("copies the complete visible log without changing clear behavior", async () => {
    const source = await (await import("node:fs/promises")).readFile(
      new URL("../../src/app/(dashboard)/dashboard/console-log/ConsoleLogClient.js", import.meta.url),
      "utf8",
    );
    expect(source).toContain('navigator.clipboard.writeText(logs.join("\\n"))');
    expect(source).toContain('setCopyStatus("Copied")');
    expect(source).toContain('method: "DELETE"');
  });
});
