import { beforeEach, describe, expect, it, vi } from "vitest";

import { classifyRouteFailure } from "../../open-sse/services/routeFailureClassifier.js";
import { handleComboChat, handleFusionChat } from "../../open-sse/services/combo.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS, ROUTE_HEALTH_CONFIG } from "../../open-sse/config/errorConfig.js";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/db/repos/routeHealthRepo.js", () => ({
  getAllRouteHealth: vi.fn(async () => ({})),
  setRouteHealth: vi.fn(async () => {}),
  removeRouteHealth: vi.fn(async () => {}),
  clearRouteHealth: vi.fn(async () => {}),
}));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
const { parseRetryAfter, recordRouteFailure, beforeRouteAttempt, clearAllRouteHealth } = await import("../../src/sse/services/routeHealth.js");

describe("route failure taxonomy", () => {
  it.each([
    [400, "This model's maximum context length is 1114112 tokens. However, your messages resulted in 1500000 tokens.", "context_overflow", "request", true],
    [400, "max_tokens may not be greater than 64000", "output_limit", "request", true],
    [400, "Context compaction rejected by upstream", "compaction_rejected", "request", true],
    [400, "Invalid value for 'temperature'", "invalid_request", "request", false],
    [422, "Unsupported parameter: response_format", "invalid_request", "request", false],
    [413, "Payload Too Large", "invalid_request", "request", true],
    [409, "Your quota will reset after 2h7m23s", "invalid_request", "request", true],
    [400, "API key not valid. Please pass a valid API key.", "authentication", "credential", true],
    [502, "stream disconnected before completion", "stream_aborted", "route", true],
    [429, "Rate limit exceeded, please retry", "transient_rate_limit", "credential", true],
    [403, "You exceeded your current quota", "quota", "credential", true],
    [401, "Invalid API key provided", "authentication", "credential", true],
    [402, "Payment required", "subscription", "credential", true],
    [429, "GenerateRequestsPerDayPerProjectPerModel-FreeTier", "daily_quota", "route", true],
    [503, "service overloaded, try again", "provider_capacity", "route", true],
    [406, "model not supported", "unsupported_model", "route", true],
    [504, "Gateway timeout", "timeout", "route", true],
    [500, "ECONNRESET: connection reset by peer", "network", "route", true],
  ])("classifies status %s as %s", (status, message, reason, scope, chainable) => {
    const classification = classifyRouteFailure(status, message);
    expect(classification.reason).toBe(reason);
    expect(classification.scope).toBe(scope);
    expect(classification.chainable).toBe(chainable);
  });

  it("schedules stream aborts from the short capacity-style policy", () => {
    const classification = classifyRouteFailure(502, "stream disconnected before completion");
    expect(classification.routeState).toBe("open");
    expect(classification.routeCooldownMs).toBe(15_000);
  });

  it("keeps locally-produced candidate 400s chainable", () => {
    // These 400s are generated before any upstream call for one unusable combo
    // candidate — other candidates may still serve the request.
    const candidateScoped = [
      "No credentials for provider: openai",
      "Invalid model format",
      "Unknown provider: foo",
      "Provider foo does not support web fetch",
    ];
    for (const text of candidateScoped) {
      expect(classifyRouteFailure(400, text).chainable).toBe(true);
    }
    expect(classifyRouteFailure(400, "Invalid value for 'temperature'").chainable).toBe(false);
  });
});

describe("request-scoped errors do not chain models", () => {
  it("stops the combo chain on an invalid request", async () => {
    const attempted = [];
    const result = await handleComboChat({
      body: { stream: true },
      models: ["p/a", "p/b"],
      handleSingleModel: async (_body, model) => {
        attempted.push(model);
        return new Response(
          JSON.stringify({ error: { message: "Invalid value for 'temperature'" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
      log: { info() {}, warn() {} },
    });

    expect(attempted).toEqual(["p/a"]);
    expect(result.status).toBe(400);
  });

  it("keeps chaining when another model may still fit the request", async () => {
    const attempted = [];
    const result = await handleComboChat({
      body: { stream: true },
      models: ["p/a", "p/b"],
      handleSingleModel: async (_body, model) => {
        attempted.push(model);
        if (model === "p/a") {
          return new Response(
            JSON.stringify({ error: { message: "This model's maximum context length is 1114112 tokens. However, your messages resulted in 1500000 tokens." } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      log: { info() {}, warn() {} },
    });

    expect(attempted).toEqual(["p/a", "p/b"]);
    expect(result.ok).toBe(true);
  });

  it("keeps chaining after a transient 409 (antigravity-style exhaustion)", async () => {
    const attempted = [];
    const result = await handleComboChat({
      body: { stream: true },
      models: ["p/a", "p/b"],
      handleSingleModel: async (_body, model) => {
        attempted.push(model);
        if (model === "p/a") {
          return new Response(
            JSON.stringify({ error: { message: "Your quota will reset after 2h7m23s" } }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      log: { info() {}, warn() {} },
    });

    expect(attempted).toEqual(["p/a", "p/b"]);
    expect(result.ok).toBe(true);
  });

  it("stops the fusion judge chain on an invalid request", async () => {
    const judgeAttempts = [];
    const result = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],
      judgeModel: "p/a",
      handleSingleModel: async (_body, model, isPanel) => {
        if (isPanel) {
          return {
            ok: true,
            status: 200,
            clone: () => ({ json: async () => ({ choices: [{ message: { role: "assistant", content: `answer-${model}` } }] }) }),
          };
        }
        judgeAttempts.push(model);
        if (model === "p/a") {
          return {
            ok: false,
            status: 400,
            clone: () => ({ json: async () => ({ error: { message: "Invalid value for 'temperature'" } }) }),
          };
        }
        return {
          ok: true,
          status: 200,
          clone: () => ({ json: async () => ({ choices: [{ message: { role: "assistant", content: "final" } }] }) }),
        };
      },
      log: { info() {}, warn() {} },
    });

    expect(judgeAttempts).toEqual(["p/a"]);
    expect(result.status).toBe(400);
  });
});

describe("temporary 429 cooldowns stay bounded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getProviderConnections.mockResolvedValue([{
      id: "conn-a",
      provider: "openai",
      name: "conn-a",
      backoffLevel: 0,
    }]);
  });

  it.each([
    ["transient rate limit", 429, "Rate limit exceeded, please retry in 48 hours"],
    ["daily-style quota with a long reset", 403, "You exceeded your current quota, retry in 48 hours"],
  ])("caps %s at the rate-limit ceiling", async (_label, status, errorText) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));

    try {
      const outcome = await markAccountUnavailable(
        "conn-a",
        status,
        errorText,
        "openai",
        "gpt-x",
        null,
        { routeAware: true },
      );

      expect(outcome.shouldFallback).toBe(true);
      expect(outcome.cooldownMs).toBeGreaterThan(0);
      expect(outcome.cooldownMs).toBeLessThanOrEqual(MAX_RATE_LIMIT_COOLDOWN_MS);

      const lock = dbMocks.updateProviderConnection.mock.calls[0][1]["modelLock_gpt-x"];
      expect(Date.parse(lock) - Date.parse("2026-10-01T00:00:00.000Z"))
        .toBeLessThanOrEqual(MAX_RATE_LIMIT_COOLDOWN_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps non-routeAware modalities (embeddings/search/...) the same way", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));

    try {
      const outcome = await markAccountUnavailable(
        "conn-a",
        429,
        "Rate limit exceeded, please retry in 48 hours",
        "openai",
        "gpt-x",
      );

      expect(outcome.shouldFallback).toBe(true);
      expect(outcome.cooldownMs).toBeGreaterThan(0);
      expect(outcome.cooldownMs).toBeLessThanOrEqual(MAX_RATE_LIMIT_COOLDOWN_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cap daily-quota cooldowns (policy reset window wins)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));

    try {
      const outcome = await markAccountUnavailable(
        "conn-a",
        429,
        "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
        "gemini",
        "gemini-2.5-pro",
        null,
        { routeAware: true },
      );

      expect(outcome.shouldFallback).toBe(true);
      expect(outcome.cooldownMs).toBeGreaterThan(MAX_RATE_LIMIT_COOLDOWN_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cap subscription resets (long upstream windows stay honored)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));

    try {
      const outcome = await markAccountUnavailable(
        "conn-a",
        402,
        "Subscription expired. Please retry in 48 hours",
        "openai",
        "gpt-x",
        null,
        { routeAware: true },
      );

      expect(outcome.shouldFallback).toBe(true);
      expect(outcome.cooldownMs).toBeGreaterThan(MAX_RATE_LIMIT_COOLDOWN_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotates accounts on auth-shaped 400s even for non-routeAware callers", async () => {
    const outcome = await markAccountUnavailable(
      "conn-a",
      400,
      "API key not valid. Please pass a valid API key.",
      "gemini",
      "gemini-2.5-pro",
    );

    expect(outcome.shouldFallback).toBe(true);
    expect(dbMocks.updateProviderConnection).toHaveBeenCalled();
  });

  it("does not lock accounts for malformed-request 400s", async () => {
    const outcome = await markAccountUnavailable(
      "conn-a",
      400,
      "Invalid value for 'temperature'",
      "openai",
      "gpt-x",
    );

    expect(outcome.shouldFallback).toBe(false);
    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});

describe("Retry-After parsing", () => {
  it("parses delta-seconds and HTTP-date forms and rejects garbage", () => {
    const now = Date.parse("2026-10-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      expect(parseRetryAfter("90")).toBe(new Date(now + 90_000).toISOString());
      expect(parseRetryAfter(45)).toBe(new Date(now + 45_000).toISOString());
      expect(parseRetryAfter(new Date(now + 3_600_000).toUTCString()))
        .toBe(new Date(now + 3_600_000).toISOString());
      expect(parseRetryAfter("soon")).toBeNull();
      expect(parseRetryAfter(null)).toBeNull();
      expect(parseRetryAfter("999999999999999")).toBeNull();
      expect(parseRetryAfter(999999999999999)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("transient 429 route exclusion stays reason-bounded", () => {
  it("does not exclude a route for a day on a hostile Retry-After", async () => {
    const now = Date.parse("2026-10-02T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      await clearAllRouteHealth();
      const { record } = await recordRouteFailure(
        "p/hostile-retry-after",
        { status: 429, errorText: "Rate limit exceeded, please retry", retryAfter: "172800" },
        now,
      );

      const cooldown = new Date(record.nextProbeAt).getTime() - now;
      expect(cooldown).toBeGreaterThan(0);
      expect(cooldown).toBeLessThanOrEqual(ROUTE_HEALTH_CONFIG.transient_rate_limit.maxMs);

      // Skipped inside the bounded window, re-admitted after it.
      expect((await beforeRouteAttempt("p/hostile-retry-after", now + 60_000)).skip).toBe(true);
      expect((await beforeRouteAttempt("p/hostile-retry-after", now + ROUTE_HEALTH_CONFIG.transient_rate_limit.maxMs + 1)).skip).toBe(false);
    } finally {
      await clearAllRouteHealth();
      vi.useRealTimers();
    }
  });

  it("retains a trustworthy daily-quota reset deadline", async () => {
    const now = Date.parse("2026-10-02T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      await clearAllRouteHealth();
      const resetAt = now + 20 * 60 * 60 * 1000;
      const { record } = await recordRouteFailure(
        "p/daily-reset",
        { status: 429, errorText: "quotaId=GenerateRequestsPerDayPerProjectPerModel-FreeTier", retryAfter: new Date(resetAt).toISOString() },
        now,
      );

      expect(new Date(record.nextProbeAt).getTime()).toBe(resetAt);
      expect((await beforeRouteAttempt("p/daily-reset", resetAt - 1)).skip).toBe(true);
      expect((await beforeRouteAttempt("p/daily-reset", resetAt + 1)).skip).toBe(false);
    } finally {
      await clearAllRouteHealth();
      vi.useRealTimers();
    }
  });
});

describe("request-scope failures never touch route health", () => {
  it("records nothing for invalid_request and context_overflow", async () => {
    await clearAllRouteHealth();
    try {
      const invalid = await recordRouteFailure(
        "p/req-invalid",
        { status: 400, errorText: "Invalid value for 'temperature'" },
        Date.now(),
      );
      expect(invalid.record).toBeNull();

      const context = await recordRouteFailure(
        "p/req-context",
        { status: 400, errorText: "This model's maximum context length is 1114112 tokens." },
        Date.now(),
      );
      expect(context.record).toBeNull();

      expect(await beforeRouteAttempt("p/req-invalid", Date.now())).toMatchObject({ skip: false, probe: false });
    } finally {
      await clearAllRouteHealth();
    }
  });
});

describe("candidate-scope 400s keep the combo chain moving", () => {
  it.each([
    ["no credentials", "No credentials for provider: p"],
    ["invalid model format", "Invalid model format"],
  ])("keeps chaining after a local %s 400", async (_label, message) => {
    const attempted = [];
    const result = await handleComboChat({
      body: { stream: true },
      models: ["p/a", "p/b"],
      handleSingleModel: async (_body, model) => {
        attempted.push(model);
        if (model === "p/a") {
          return new Response(
            JSON.stringify({ error: { message } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      log: { info() {}, warn() {} },
    });

    expect(attempted).toEqual(["p/a", "p/b"]);
    expect(result.ok).toBe(true);
  });
});

describe("probe decision plumbing", () => {
  const sse = () => new Response(
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );

  it("returns the exact attempt decision to combo completion callbacks", async () => {
    const attemptDecisions = [];
    const seen = { success: null, failure: null, cancelled: null };
    const before = async (_model, options) => {
      if (options?.inspectOnly) return { skip: false };
      const decision = { skip: false, probe: true, probeToken: `tok-${attemptDecisions.length}` };
      attemptDecisions.push(decision);
      return decision;
    };

    await handleComboChat({
      body: { stream: true },
      models: ["p/a"],
      handleSingleModel: async () => sse(),
      beforeModelAttempt: before,
      onModelSuccess: (_model, decision) => { seen.success = decision; },
      log: { info() {}, warn() {} },
    });
    expect(seen.success).toBe(attemptDecisions[0]);

    await handleComboChat({
      body: { stream: true },
      models: ["p/a"],
      handleSingleModel: async () => new Response(
        JSON.stringify({ error: { message: "rate limit" } }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
      beforeModelAttempt: before,
      onModelFailure: (_model, _failure, decision) => { seen.failure = decision; },
      log: { info() {}, warn() {} },
    });
    expect(seen.failure).toBe(attemptDecisions[1]);

    const controller = new AbortController();
    controller.abort();
    await handleComboChat({
      body: { stream: true },
      models: ["p/a"],
      handleSingleModel: async () => sse(),
      beforeModelAttempt: before,
      onModelCancelled: (_model, decision) => { seen.cancelled = decision; },
      requestSignal: controller.signal,
      log: { info() {}, warn() {} },
    });
    expect(seen.cancelled).toBe(attemptDecisions[2]);
  });

  it("returns the exact attempt decision to fusion panel and judge callbacks", async () => {
    const successes = [];
    const failures = [];
    const before = async (model, options) => {
      if (options?.inspectOnly) return { skip: false };
      return { skip: false, probe: true, probeToken: `tok-${model}` };
    };
    const json = (payload, status = 200) => new Response(
      JSON.stringify(payload),
      { status, headers: { "content-type": "application/json" } },
    );

    const result = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["p/a", "p/b"],
      judgeModel: "p/judge",
      handleSingleModel: async (_body, model, isPanel) => {
        if (isPanel) return json({ choices: [{ message: { role: "assistant", content: `answer-${model}` } }] });
        if (model === "p/judge") return json({ error: { message: "capacity exploded" } }, 500);
        return json({ choices: [{ message: { role: "assistant", content: "final" } }] });
      },
      beforeModelAttempt: before,
      onModelSuccess: (model, decision) => successes.push({ model, decision }),
      onModelFailure: (model, _failure, decision) => failures.push({ model, decision }),
      log: { info() {}, warn() {} },
    });

    expect(result.ok).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0].model).toBe("p/judge");
    expect(failures[0].decision?.probeToken).toBe("tok-p/judge");
    expect(successes).toHaveLength(3);
    for (const entry of successes) {
      expect(entry.decision?.probeToken).toBe(`tok-${entry.model}`);
    }
  });
});
