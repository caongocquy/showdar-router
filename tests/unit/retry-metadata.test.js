import { describe, expect, it } from "vitest";
import { extractRetryDeadline } from "open-sse/services/retryMetadata.js";

const NOW = Date.parse("2026-09-10T00:00:00.000Z");

describe("retry metadata precedence", () => {
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
});
