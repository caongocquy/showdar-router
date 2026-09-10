import { describe, expect, it, vi } from "vitest";
import { extractRetryDeadline } from "open-sse/services/retryMetadata.js";
import { parseUpstreamError } from "open-sse/utils/error.js";

const NOW = Date.parse("2026-09-10T00:00:00.000Z");

describe("retry metadata precedence", () => {
  const openRouterBody = (headerName, reset) => ({
    error: {
      message: "Rate limit exceeded: free-models-per-day...",
      code: 429,
      metadata: {
        headers: {
          "X-RateLimit-Limit": "50",
          "X-RateLimit-Remaining": "0",
          [headerName]: reset,
        },
        limit_source: "openrouter_free_tier_daily",
      },
    },
  });

  it("uses OpenRouter nested millisecond reset metadata", () => {
    expect(extractRetryDeadline({
      errorBody: openRouterBody("X-RateLimit-Reset", "1789084800000"),
      errorText: "Rate limit exceeded",
      now: NOW,
    })).toBe(new Date(1789084800000).toISOString());
  });

  it("finds lowercase nested reset headers and epoch seconds", () => {
    expect(extractRetryDeadline({
      errorBody: openRouterBody("x-ratelimit-reset", 1789084800),
      now: NOW,
    })).toBe(new Date(1789084800000).toISOString());
  });

  it("passes the same provider reset deadline to account-lock callers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const parsed = await parseUpstreamError(new Response(JSON.stringify(
        openRouterBody("X-RateLimit-Reset", "1789084800000"),
      ), { status: 429, headers: { "content-type": "application/json" } }));

      expect(parsed.resetsAtMs).toBe(1789084800000);
      expect(extractRetryDeadline({ resetAt: parsed.resetsAtMs, now: NOW }))
        .toBe(new Date(1789084800000).toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls through malformed or expired reset metadata safely", () => {
    expect(extractRetryDeadline({
      errorBody: { error: { metadata: { headers: { "X-RateLimit-Reset": "not-a-time" }, retryDelay: "12s" } } },
      now: NOW,
    })).toBe(new Date(NOW + 12_000).toISOString());

    expect(extractRetryDeadline({
      errorBody: openRouterBody("X-RateLimit-Reset", NOW - 1),
      now: NOW,
    })).toBeNull();
  });

  it("prefers an explicit reset timestamp", () => {
    const deadline = extractRetryDeadline({
      resetAt: new Date(NOW + 90_000).toISOString(),
      retryAfterHeader: "5",
      errorBody: { retryDelay: "2m" },
      now: NOW,
    });

    expect(deadline).toBe(new Date(NOW + 90_000).toISOString());
  });

  it("uses Retry-After before structured body metadata", () => {
    const deadline = extractRetryDeadline({
      retryAfterHeader: "5",
      errorBody: { retryAfter: "2m" },
      now: NOW,
    });

    expect(deadline).toBe(new Date(NOW + 5_000).toISOString());
  });

  it("keeps nested absolute reset metadata ahead of body delays", () => {
    expect(extractRetryDeadline({
      errorBody: {
        retryDelay: "2s",
        error: { metadata: { headers: { "X-RateLimit-Reset": "1789084800000" } } },
      },
      now: NOW,
    })).toBe(new Date(1789084800000).toISOString());
  });

  it("accepts resetsAt and retryDelay in provider bodies", () => {
    expect(extractRetryDeadline({
      errorBody: { resetsAt: new Date(NOW + 120_000).toISOString() },
      now: NOW,
    })).toBe(new Date(NOW + 120_000).toISOString());

    expect(extractRetryDeadline({
      errorBody: { retryDelay: "2m" },
      now: NOW,
    })).toBe(new Date(NOW + 120_000).toISOString());
  });

  it("parses human retry durations including fractional seconds", () => {
    expect(extractRetryDeadline({
      errorText: "Please retry in 42.482244891s",
      now: NOW,
    })).toBe(new Date(NOW + 42_482).toISOString());

  });

  it("keeps Gemini structured and textual retry hints", () => {
    expect(extractRetryDeadline({
      errorBody: {
        error: {
          details: [{
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "12s",
          }],
        },
      },
      errorText: "Please retry in 12.593730818s",
      now: NOW,
    })).toBe(new Date(NOW + 12_000).toISOString());

    expect(extractRetryDeadline({
      errorText: "Please retry in 12.593730818s",
      now: NOW,
    })).toBe(new Date(NOW + 12_594).toISOString());
  });
});
