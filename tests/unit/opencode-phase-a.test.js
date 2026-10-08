import { describe, expect, it } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

const VALID_SESSION = "ses_abcdef123456ABCDEFGHIJKLMN";
const VALID_REQUEST = "msg_abcdef123456ABCDEFGHIJKLMN";
const MUSE_FREE = "muse-spark-1.3-contributor-free";

function headersOf(ex, creds, stream = true) {
  return ex.buildHeaders(ex.prepareRequestCredentials(creds), stream);
}

describe("opencode phase A correctness", () => {
  it("replaces bare/stale downstream UA, preserves valid opencode UA", () => {
    const ex = new OpenCodeExecutor();
    for (const ua of ["opencode", "opencode/1.15.2", "Claude-Code/1.0", undefined]) {
      const rawHeaders = ua ? { "user-agent": ua } : {};
      const h = headersOf(ex, { body: {}, credentials: { rawHeaders, connectionId: "t" } });
      expect(h["User-Agent"]).toMatch(/^opencode\/1\.(1[7-9]|[2-9]\d)/);
    }
    const valid = "opencode/1.18.31";
    const kept = headersOf(ex, { body: {}, credentials: { rawHeaders: { "user-agent": valid } }, rawHeaders: { "user-agent": valid } });
    expect(kept["User-Agent"]).toBe(valid);
  });

  it("preserves valid native session, canonicalizes foreign ids", () => {
    const ex = new OpenCodeExecutor();
    const native = headersOf(ex, { body: {}, credentials: { rawHeaders: { "x-opencode-session": VALID_SESSION } } });
    expect(native["x-opencode-session"]).toBe(VALID_SESSION);
    const a = ex.prepareRequestCredentials({ body: {}, credentials: { connectionId: "c1" }, providerSessionId: "conv-a", clientTool: "claude" })._opencodeSession;
    const b = ex.prepareRequestCredentials({ body: {}, credentials: { connectionId: "c1" }, providerSessionId: "conv-a", clientTool: "claude" })._opencodeSession;
    expect(a).toBe(b);
    expect(a).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it("reuses stable session across requests without hints and isolates identities", () => {
    const ex = new OpenCodeExecutor();
    const mk = (connectionId) => ex.prepareRequestCredentials({ body: { messages: [{ role: "user", content: "hi" }] }, credentials: { connectionId } })._opencodeSession;
    expect(mk("same")).toBe(mk("same"));
    expect(mk("same")).not.toBe(mk("other"));
    expect(ex).not.toHaveProperty("_currentSessionId");
  });

  it("derives deterministic request ids per logical request", () => {
    const ex = new OpenCodeExecutor();
    const mk = (text, logicalRequestId) => ex.prepareRequestCredentials({ body: { messages: [{ role: "user", content: text }] }, credentials: { connectionId: "r1" }, logicalRequestId })._opencodeRequest;
    // Same logical request (internal retry) → same id, body text irrelevant.
    expect(mk("hello", "urn:lr:1")).toBe(mk("hello again", "urn:lr:1"));
    // Distinct logical requests → distinct ids, even with identical bodies.
    const first = mk("hello", "urn:lr:1");
    expect(first).not.toBe(mk("hello", "urn:lr:2"));
    expect(first).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    // Missing logical id → fresh id per attempt.
    expect(mk("hello")).not.toBe(mk("hello"));
    // Explicit downstream x-opencode-request header still wins.
    const native = ex.prepareRequestCredentials({ body: { messages: [] }, credentials: { rawHeaders: { "x-opencode-request": VALID_REQUEST } } })._opencodeRequest;
    expect(native).toBe(VALID_REQUEST);
  });

  it("forces upstream stream and declares forceStream transport", () => {
    const ex = new OpenCodeExecutor();
    const body = { messages: [{ role: "user", content: "hi" }], stream: false };
    ex.transformRequest("big-pickle", body, false, {});
    expect(body.stream).toBe(true);
    expect(PROVIDERS.opencode?.forceStream ?? PROVIDERS.opencode?.transport?.forceStream).toBe(true);
  });

  it("normalizes explicit Muse 1.3 free tool_choice to auto only", () => {
    const ex = new OpenCodeExecutor();
    const body = { model: MUSE_FREE, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], tool_choice: { type: "function", name: "x" } };
    ex.transformRequest(MUSE_FREE, body, true, {});
    expect(body.tool_choice).toBe("auto");
    const other = { model: "big-pickle", messages: [{ role: "user", content: "hi" }], tool_choice: "none" };
    ex.transformRequest("big-pickle", other, true, {});
    expect(other.tool_choice).toBe("none");
  });

  it("strips prior reasoning on Muse responses path only", () => {
    const ex = new OpenCodeExecutor();
    const body = {
      model: MUSE_FREE,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "reasoning", id: "rs_1", encrypted_content: "ENC" },
        { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
      ],
    };
    ex.transformRequest(MUSE_FREE, body, true, {});
    expect(body.input.some((i) => i.type === "reasoning")).toBe(false);
    expect(JSON.stringify(body.input)).not.toContain("ENC");
    expect(body.input.map((i) => i.type)).toEqual(["message", "function_call", "function_call_output", "message"]);
    const chat = { messages: [{ role: "user", content: "hi" }], reasoning_content: "keep me" };
    ex.transformRequest("big-pickle", chat, true, {});
    expect(chat.reasoning_content).toBe("keep me");
  });

  it("satisfies fingerprint tools without duplicating or leaking", () => {
    const ex = new OpenCodeExecutor();
    const body = { model: MUSE_FREE, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] };
    const out = ex.transformRequest(MUSE_FREE, body, true, {});
    const names = out.tools.map((t) => t.name);
    expect(names).toContain("bash");
    expect(names).toContain("read");
    expect(new Set(names).size).toBe(names.length);
    const again = ex.transformRequest(MUSE_FREE, { model: MUSE_FREE, input: body.input, tools: structuredClone(out.tools) }, true, {});
    expect(again.tools.length).toBe(out.tools.length);
  });

  it("cloaks chat with bash/read decoys, preserves externals, no dupes", () => {
    const ex = new OpenCodeExecutor();
    const noTools = ex.transformRequest("big-pickle", { messages: [{ role: "user", content: "hi" }] }, true, {});
    expect(noTools.stream).toBe(true);
    expect(noTools.tool_choice).toBe("none");
    expect(noTools.tools.map((t) => t.function?.name)).toEqual(["bash", "read"]);
    const withExt = ex.transformRequest("big-pickle", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "Bash", description: "Claude Code tool" } }],
      tool_choice: "auto",
    }, true, {});
    expect(withExt.tool_choice).toBe("auto");
    const names = withExt.tools.map((t) => t.function?.name);
    expect(names).toContain("Bash");
    expect(names).toContain("bash");
    expect(names).toContain("read");
  });

  it("preserves pre-existing tools and injects decoys on chat path", () => {
    const ex = new OpenCodeExecutor();
    const own = { type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: {} } } };
    const out = ex.transformRequest("big-pickle", { messages: [{ role: "user", content: "hi" }], tools: [structuredClone(own)] }, true, {});
    expect(out.tools.map((t) => t.function?.name || t.name)).toContain("get_weather");
    expect(out.tools.map((t) => t.function?.name || t.name)).toContain("bash");
    const names = out.tools.map((t) => (t.function?.name || t.name).toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps concurrent sessions/requests isolated", async () => {
    const ex = new OpenCodeExecutor();
    const run = async (id, text, delay) => {
      const prepared = ex.prepareRequestCredentials({ body: { messages: [{ role: "user", content: text }] }, credentials: { connectionId: id } });
      await new Promise((r) => setTimeout(r, delay));
      return ex.buildHeaders(prepared, true);
    };
    const [a, b] = await Promise.all([run("conn-a", "alpha task", 20), run("conn-b", "beta task", 5)]);
    expect(a["x-opencode-session"]).not.toBe(b["x-opencode-session"]);
    expect(a["x-opencode-request"]).not.toBe(b["x-opencode-request"]);
  });
});
