import { DAILY_QUOTA_MIN_PROBE_MS } from "../config/errorConfig.js";

export class RouteHealthState {
  constructor(storage) {
    if (!storage) throw new Error("RouteHealthState requires storage");
    this.storage = storage;
    this.records = new Map();
    this.probes = new Map();
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
    if (this.probes.has(model)) return { ...decision, skip: true, probe: false };
    this.probes.set(model, record.state);
    this.records.set(model, { ...record, state: "half_open" });
    return { ...decision, probe: true };
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

  async recordFailure(model, failure, retryAfter = null, now = Date.now(), errorText = null) {
    await this.hydrate();
    const previous = this.records.get(model);
    const failureCount = (previous?.failureCount || 0) + 1;
    const fallbackDeadline = now + Math.max(0, Number(failure?.routeCooldownMs) || 0);
    const retryAfterMs = retryAfter ? new Date(retryAfter).getTime() : NaN;
    // Explicit upstream recovery metadata is authoritative. Generic route
    // cooldown is only a fallback when the provider gives no usable deadline.
    const isDailyQuota = failure?.reason === "daily_quota";
    const hasShortDailyRetry = isDailyQuota && Number.isFinite(retryAfterMs)
      && retryAfterMs > now && retryAfterMs - now < DAILY_QUOTA_MIN_PROBE_MS;
    const deadline = Number.isFinite(retryAfterMs) && retryAfterMs > now && !hasShortDailyRetry
      ? retryAfterMs
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

  async recordSuccess(model) {
    await this.hydrate();
    this.probes.delete(model);
    if (!this.records.has(model)) return;
    this.records.delete(model);
    this.enqueue(() => this.storage.remove(model));
  }

  async cancelProbe(model) {
    await this.hydrate();
    const previousState = this.probes.get(model);
    this.probes.delete(model);
    const record = this.records.get(model);
    if (record?.state === "half_open") {
      this.records.set(model, { ...record, state: previousState || "cooldown" });
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
