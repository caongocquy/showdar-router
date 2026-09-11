import { describe, expect, it } from "vitest";
import { RouteHealthState } from "open-sse/services/routeHealthState.js";

function storage(initial = {}) {
  const values = { ...initial };
  return {
    async getAll() { return { ...values }; },
    async set(key, value) { values[key] = value; },
    async remove(key) { delete values[key]; },
    async clear() { for (const key of Object.keys(values)) delete values[key]; },
  };
}

describe("route health persistence and probing", () => {
  it("skips cooldown, permits one half-open probe, and clears on success", async () => {
    const state = new RouteHealthState(storage());
    const now = Date.parse("2026-09-10T00:00:00.000Z");
    const failure = await state.recordFailure(
      "provider/model",
      { routeState: "cooldown", reason: "rate_limited", routeCooldownMs: 60_000, effectiveStatus: 429 },
      null,
      now,
    );

    expect(failure.nextProbeAt).toBe(new Date(now + 60_000).toISOString());
    expect((await state.beforeAttempt("provider/model", now + 1_000)).skip).toBe(true);
    expect((await state.beforeAttempt("provider/model", now + 60_001)).probe).toBe(true);
    expect((await state.beforeAttempt("provider/model", now + 60_002)).skip).toBe(true);

    await state.recordSuccess("provider/model");
    expect((await state.beforeAttempt("provider/model", now + 60_003)).skip).toBe(false);
  });

  it("hydrates persisted cooldown state", async () => {
    const now = Date.parse("2026-09-10T00:00:00.000Z");
    const backing = storage();
    const first = new RouteHealthState(backing);
    await first.recordFailure("provider/model", {
      routeState: "cooldown",
      reason: "upstream_503",
      routeCooldownMs: 300_000,
      effectiveStatus: 503,
    }, null, now);
    await first.flush();

    const second = new RouteHealthState(backing);
    const decision = await second.beforeAttempt("provider/model", now + 1_000);
    expect(decision.skip).toBe(true);
    expect(decision.nextProbeAt).toBe(new Date(now + 300_000).toISOString());
  });

  it("releases a cancelled half-open probe without changing route health", async () => {
    const state = new RouteHealthState(storage());
    const now = Date.parse("2026-09-10T00:00:00.000Z");
    await state.recordFailure("provider/model", {
      routeState: "cooldown", reason: "rate_limited", routeCooldownMs: 60_000, effectiveStatus: 429,
    }, null, now);
    expect((await state.beforeAttempt("provider/model", now + 60_001)).probe).toBe(true);
    await state.cancelProbe("provider/model");
    const snapshot = await state.snapshot();
    expect(snapshot["provider/model"]).toMatchObject({ state: "cooldown", failureCount: 1 });
    expect((await state.beforeAttempt("provider/model", now + 60_002)).probe).toBe(true);
  });
});
