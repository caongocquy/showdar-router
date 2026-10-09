import { DAILY_QUOTA_MIN_PROBE_MS, ROUTE_HEALTH_CONFIG, ROUTE_PROBE_LEASE_MS } from "../config/errorConfig.js";
import { MAX_METADATA_DELAY_MS } from "./retryMetadata.js";

export class RouteHealthState {
  constructor(storage) {
    if (!storage) throw new Error("RouteHealthState requires storage");
    this.storage = storage;
    this.records = new Map();
    this.probes = new Map();
    this.probeSeq = 0;
    this.hydrated = false;
    this.hydrationPromise = null;
    this.persistenceTail = Promise.resolve();
  }

  async hydrate() {
    if (this.hydrated) return;
    if (!this.hydrationPromise) {
      this.hydrationPromise = (async () => {
        const all = await this.storage.getAll();
        this.records = new Map(Object.entries(all || {}));
        this.hydrated = true;
      })().finally(() => {
        this.hydrationPromise = null;
      });
    }
    await this.hydrationPromise;
  }

  enqueue(operation) {
    this.persistenceTail = this.persistenceTail
      .catch(() => {})
      .then(operation)
      .catch(() => {});
    return this.persistenceTail;
  }

  async beforeAttempt(model, now = Date.now()) {
    await this.hydrate();
    const decision = this.inspect(model, now);
    if (decision.skip) return decision;
    const record = this.records.get(model);
    if (!record) return decision;
    const lease = this.probes.get(model);
    if (lease && now - lease.startedAt < ROUTE_PROBE_LEASE_MS) {
      return { ...decision, skip: true, probe: false };
    }
    // Ownership token: only the completion presenting this exact token may
    // mutate circuit state, so an expired/hung probe can never overwrite a
    // newer probe's decision.
    const probeToken = ++this.probeSeq;
    this.probes.set(model, { state: lease?.state ?? record.state, startedAt: now, token: probeToken });
    this.records.set(model, { ...record, state: "half_open" });
    return { ...decision, probe: true, probeToken };
  }

  inspect(model, now = Date.now()) {
    const record = this.records.get(model);
    if (!record) return { skip: false, probe: false, reason: null, nextProbeAt: null };

    const nextProbeMs = new Date(record.nextProbeAt).getTime();
    if (Number.isFinite(nextProbeMs) && now < nextProbeMs) {
      return {
        skip: true,
        probe: false,
        reason: record.reason,
        nextProbeAt: record.nextProbeAt,
      };
    }

    return {
      skip: false,
      probe: false,
      reason: record.reason,
      nextProbeAt: record.nextProbeAt,
    };
  }

  async recordFailure(model, failure, retryAfter = null, now = Date.now(), errorText = null, probeToken = null) {
    await this.hydrate();
    // A result from a superseded/expired probe must never overwrite the newer
    // probe's (or a recovered route's) decision.
    if (probeToken != null && this.probes.get(model)?.token !== probeToken) return null;
    const previous = this.records.get(model);
    const failureCount = (previous?.failureCount || 0) + 1;
    const fallbackDeadline = now + Math.max(0, Number(failure?.routeCooldownMs) || 0);
    const retryAfterMs = retryAfter ? new Date(retryAfter).getTime() : NaN;
    // Explicit upstream recovery metadata is authoritative. Generic route
    // cooldown is only a fallback when the provider gives no usable deadline.
    const isDailyQuota = failure?.reason === "daily_quota";
    const hasShortDailyRetry = isDailyQuota && Number.isFinite(retryAfterMs)
      && retryAfterMs > now && retryAfterMs - now < DAILY_QUOTA_MIN_PROBE_MS;
    // Quota-family deadlines are provider reset truth (daily windows) and keep
    // the full metadata ceiling; every other reason's explicit upstream deadline
    // is capped at its configured route window so a hostile or broken
    // Retry-After cannot pin a route far beyond policy (a transient 429 must
    // not sit out a 24h hint while its credential cools down for 30 minutes).
    const policy = ROUTE_HEALTH_CONFIG[failure?.reason] || ROUTE_HEALTH_CONFIG.unknown;
    const ceilingMs = (failure?.reason === "quota" || failure?.reason === "daily_quota")
      ? MAX_METADATA_DELAY_MS
      : policy.maxMs;
    const boundedRetryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs > now
      ? Math.min(retryAfterMs, now + ceilingMs)
      : NaN;
    const deadline = Number.isFinite(boundedRetryAfterMs) && !hasShortDailyRetry
      ? boundedRetryAfterMs
      : fallbackDeadline;

    const record = {
      model,
      state: failure?.routeState === "cooldown" ? "cooldown" : "open",
      reason: failure?.reason || "unknown",
      failureCount,
      lastFailureAt: new Date(now).toISOString(),
      nextProbeAt: new Date(deadline).toISOString(),
      lastStatus: Number.isFinite(Number(failure?.effectiveStatus)) ? Number(failure.effectiveStatus) : null,
      lastError: errorText ? String(errorText).slice(0, 500) : null,
    };

    this.probes.delete(model);
    this.records.set(model, record);
    this.enqueue(() => this.storage.set(model, record));
    return record;
  }

  async recordSuccess(model, probeToken = null) {
    await this.hydrate();
    // Stale probe fencing (see recordFailure): only the active lease holder
    // may clear route state.
    if (probeToken != null && this.probes.get(model)?.token !== probeToken) return;
    this.probes.delete(model);
    if (!this.records.has(model)) return;
    this.records.delete(model);
    this.enqueue(() => this.storage.remove(model));
  }

  async cancelProbe(model, probeToken = null) {
    await this.hydrate();
    // A late cancellation from an expired probe must not release the newer
    // probe's lease.
    if (probeToken != null && this.probes.get(model)?.token !== probeToken) return;
    const lease = this.probes.get(model);
    this.probes.delete(model);
    const record = this.records.get(model);
    if (record?.state === "half_open") {
      this.records.set(model, { ...record, state: lease?.state || "cooldown" });
    }
  }

  async snapshot() {
    await this.hydrate();
    return Object.fromEntries(this.records);
  }

  async flush() {
    await this.persistenceTail;
  }

  async clear() {
    await this.hydrate();
    this.records.clear();
    this.probes.clear();
    this.enqueue(() => this.storage.clear());
    await this.flush();
  }
}
