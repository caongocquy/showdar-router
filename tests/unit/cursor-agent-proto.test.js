import { describe, expect, it } from "vitest";
import { decodeMessage } from "../../open-sse/utils/cursorProtobuf.js";
import {
  buildAgentRunFrame,
  isAgentTextRequest,
} from "../../open-sse/executors/cursor.js";

// AgentService (agent.v1) text-turn coverage for the current executor.
// Tool-call history stays on the legacy path until the AgentService tool
// protocol is implemented, so these tests pin the supported text contract.

const str = (value) => (value ? Buffer.from(value).toString("utf8") : "");
const unwrapFrame = (frame) => {
  expect(frame[0]).toBe(0);
  const length = (frame[1] << 24) | (frame[2] << 16) | (frame[3] << 8) | frame[4];
  expect(frame.length).toBe(5 + length);
  return frame.subarray(5);
};

function decodeRun(frame) {
  const client = decodeMessage(unwrapFrame(frame));
  const run = decodeMessage(client.get(1)[0].value);
  const action = decodeMessage(run.get(2)[0].value);
  const userAction = decodeMessage(action.get(1)[0].value);
  const userMessage = decodeMessage(userAction.get(1)[0].value);
  const history = userAction.get(7)?.[0]?.value
    ? decodeMessage(userAction.get(7)[0].value)
    : null;
  return {
    run,
    userAction,
    userText: str(userMessage.get(1)?.[0]?.value),
    system: str(run.get(8)?.[0]?.value),
    model: str(decodeMessage(run.get(9)[0].value).get(1)?.[0]?.value),
    history: history?.get(1)?.map((entry) => decodeMessage(entry.value)),
  };
}

describe("Cursor AgentService text request selection", () => {
  it("accepts a plain text conversation", () => {
    expect(isAgentTextRequest({ messages: [{ role: "user", content: "hi" }] })).toBe(true);
  });

  it("accepts array-form text parts", () => {
    expect(isAgentTextRequest({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })).toBe(true);
  });

  it("ignores declared tool schemas because they do not make the turn a tool turn", () => {
    expect(isAgentTextRequest({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "Read" } }],
    })).toBe(true);
  });

  it("rejects tool-call history", () => {
    expect(isAgentTextRequest({
      messages: [
        { role: "user", content: "read it" },
        { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function" }] },
      ],
    })).toBe(false);
  });

  it("rejects tool-result messages", () => {
    expect(isAgentTextRequest({
      messages: [{ role: "tool", tool_call_id: "1", content: "result" }],
    })).toBe(false);
  });

  it("rejects image content", () => {
    expect(isAgentTextRequest({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x" } }] }],
    })).toBe(false);
  });

  it("rejects bodies without a messages array", () => {
    expect(isAgentTextRequest({})).toBe(false);
  });
});

describe("Cursor AgentService Run frame", () => {
  it("wraps the run request in a Connect frame", () => {
    const frame = buildAgentRunFrame([{ role: "user", content: "hello" }], "composer-2.5");
    expect(frame).toBeInstanceOf(Uint8Array);
    expect(frame.length).toBeGreaterThan(5);
  });

  it("sends the latest user turn as the current message and requested model", () => {
    const run = decodeRun(buildAgentRunFrame([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ], "composer-2.5"));

    expect(run.userText).toBe("second");
    expect(run.model).toBe("composer-2.5");
  });

  it("folds system messages into the RunRequest system field", () => {
    const run = decodeRun(buildAgentRunFrame([
      { role: "system", content: "be concise" },
      { role: "system", content: "use tools carefully" },
      { role: "user", content: "hi" },
    ], "composer-2.5"));

    expect(run.system).toBe("be concise\n\nuse tools carefully");
    expect(run.userText).toBe("hi");
  });

  it("preserves text-only history before the current user turn", () => {
    const run = decodeRun(buildAgentRunFrame([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ], "composer-2.5"));

    expect(run.history).toHaveLength(2);
    expect(run.history[0].has(1)).toBe(true);
    expect(run.history[1].has(2)).toBe(true);
  });

  it("does not encode tool schemas on the supported text path", () => {
    const run = decodeRun(buildAgentRunFrame([{ role: "user", content: "hi" }], "composer-2.5"));
    expect(run.run.has(4)).toBe(false);
  });
});
