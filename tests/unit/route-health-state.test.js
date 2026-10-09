import { describe, expect, it } from "vitest";
import { RouteHealthState } from "open-sse/services/routeHealthState.js";
import { ROUTE_HEALTH_CONFIG, ROUTE_PROBE_LEASE_MS } from "open-sse/config/errorConfig.js";

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

  it("bounds an upstream Retry-After deadline by the reason policy ceiling", async () => {
    const state = new RouteHealthState(storage());
    const now = Date.parse("2026-09-10T00:00:00.000Z");
    const failure = await state.recordFailure(
      "provider/model",
      { routeState: "cooldown", reason: "transient_rate_limit", routeCooldownMs: 30_000, effectiveStatus: 429 },
      new Date(now + 48 * 60 * 60 * 1000).toISOString(),
      now,
    );

    const cooldown = new Date(failure.nextProbeAt).getTime() - now;
    expect(cooldown).toBeLessThanOrEqual(ROUTE_HEALTH_CONFIG.transient_rate_limit.maxMs);
    expect(cooldown).toBeGreaterThan(0);
  });

  it("re-admits a probe after the probe lease expires", async () => {
    const state = new RouteHealthState(storage());
    const now = Date.parse("2026-09-10T00:00:00.000Z");
    await state.recordFailure(
      "provider/model",
      { routeState: "cooldown", reason: "rate_limited", routeCooldownMs: 60_000, effectiveStatus: 429 },
      null,
      now,
    );

    expect((await state.beforeAttempt("provider/model", now + 60_001)).probe).toBe(true);
    expect((await state.beforeAttempt("provider/model", now + 60_002)).skip).toBe(true);
    const reAdmittedAt = now + 60_001 + ROUTE_PROBE_LEASE_MS + 1;
    expect((await state.beforeAttempt("provider/model", reAdmittedAt)).probe).toBe(true);

    await state.cancelProbe("provider/model");
    expect((await state.snapshot())["provider/model"].state).toBe("cooldown");
    expect((await state.beforeAttempt("provider/model", reAdmittedAt + 1)).probe).toBe(true);
  });

  it("falls back to the policy cooldown when Retry-After is already past", async () => {
    const state = new RouteHealthState(storage());
    const now = Date.parse("2026-09-10T00:00:00.000Z");
    const failure = await state.recordFailure(
      "provider/model",
      { routeState: "cooldown", reason: "transient_rate_limit", routeCooldownMs: 30_000, effectiveStatus: 429 },
      new Date(now - 1_000).toISOString(),
      now,
    );

    expect(failure.nextProbeAt).toBe(new Date(now + 30_000).toISOString());
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

  it("ignores a stale probe failure after a newer probe already recovered the route", async () => {
    const state = new RouteHealthState(storage());
    const now = Date.parse("2026-09-10T00:00:00.000Z");
    const model = "provider/stale-fail";
    await state.recordFailure(model, {
      routeState: "cooldown", reason: "rate_limited", routeCooldownMs: 60_000, effectiveStatus: 429,
    }, null, now);

    // Probe A admitted, hangs beyond the lease window.
    const probeA = await state.beforeAttempt(model, now + 60_001);
    expect(probeA.probe).toBe(true);
    // Probe B takes over after A's lease expires.
    const probeB = await state.beforeAttempt(model, now + 60_001 + ROUTE_PROBE_LEASE_MS + 1);
    expect(probeB.probe).toBe(true);
    expect(probeB.probeToken).not.toBe(probeA.probeToken);

    // B succeeds and restores healthy state.
    await state.recordSuccess(model, probeB.probeToken);
    expect((await state.snapshot())[model]).toBeUndefined();

    // A returns late with an error — it must not corrupt B's newer decision.
    const late = await state.recordFailure(model, {
      routeState: "open", reason: "network", routeCooldownMs: 30_000, effectiveStatus: 500,
    }, null, now + 60_002 + ROUTE_PROBE_LEASE_MS, "late failure", probeA.probeToken);
    expect(late).toBeNull();
    expect((await state.snapshot())[model]).toBeUndefined();
    expect((await state.beforeAttempt(model, now + 60_003 + ROUTE_PROBE_LEASE_MS)).skip).toBe(false);
  });

  it("ignores a stale probe success after a newer probe recorded a failure", async () => {
    const state = new RouteHealthState(storage());
    const now = Date.parse("2026-09-10T00:00:00.000Z");
    const model = "provider/stale-ok";
    await state.recordFailure(model, {
      routeState: "cooldown", reason: "rate_limited", routeCooldownMs: 60_000, effectiveStatus: 429,
    }, null, now);

    const probeA = await state.beforeAttempt(model, now + 60_001);
    const probeB = await state.beforeAttempt(model, now + 60_001 + ROUTE_PROBE_LEASE_MS + 1);

    // B fails first and records its failure.
    await state.recordFailure(model, {
      routeState: "cooldown", reason: "rate_limited", routeCooldownMs: 60_000, effectiveStatus: 429,
    }, null, now + 60_002 + ROUTE_PROBE_LEASE_MS, "b failed", probeB.probeToken);
    expect((await state.snapshot())[model]).toBeDefined();

    // A's late success must not clear B's newer failure record.
    await state.recordSuccess(model, probeA.probeToken);
    const record = (await state.snapshot())[model];
    expect(record).toBeDefined();
    expect(record.failureCount).toBe(2);
  });

  it("does not let a stale cancellation reset a newer probe", async () => {
    const state = new RouteHealthState(storage());
    const now = Date.parse("2026-09-10T00:00:00.000Z");
    const model = "provider/stale-cancel";
    await state.recordFailure(model, {
      routeState: "cooldown", reason: "rate_limited", routeCooldownMs: 60_000, effectiveStatus: 429,
    }, null, now);

    const probeA = await state.beforeAttempt(model, now + 60_001);
    const probeB = await state.beforeAttempt(model, now + 60_001 + ROUTE_PROBE_LEASE_MS + 1);
    expect(probeB.probe).toBe(true);

    await state.cancelProbe(model, probeA.probeToken);
    // B's probe must stay in charge.
    expect((await state.snapshot())[model].state).toBe("half_open");
    expect((await state.beforeAttempt(model, now + 60_002 + ROUTE_PROBE_LEASE_MS)).skip).toBe(true);

    // B's own completion still applies.
    await state.recordSuccess(model, probeB.probeToken);
    expect((await state.snapshot())[model]).toBeUndefined();
  });

  it("admits only one probe when two attempts arrive at the same instant", async () => {
    const state = new RouteHealthState(storage());
    const now = Date.parse("2026-09-10T00:00:00.000Z");
    const model = "provider/stampede";
    await state.recordFailure(model, {
      routeState: "cooldown", reason: "rate_limited", routeCooldownMs: 60_000, effectiveStatus: 429,
    }, null, now);

    const admittedAt = now + 60_001;
    const first = await state.beforeAttempt(model, admittedAt);
    const second = await state.beforeAttempt(model, admittedAt);
    expect(first.probe).toBe(true);
    expect(second.skip).toBe(true);
    expect(second.probe).toBe(false);
  });
});
