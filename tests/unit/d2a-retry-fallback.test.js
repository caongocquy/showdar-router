// Phase D2A: evidence-based retry and fallback optimization.
// Locks the combo-aware retry budget, reason-aware retry gate,
// FreeTierError classification, and cancellation-aware backoff.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { classifyRouteFailure, isRouteHealthRelevant } = await import("../../open-sse/services/routeFailureClassifier.js");

function res(status, bodyText = "") {
  return new Response(bodyText, { status });
}

function makeExec(config) {
  return new BaseExecutor("test", config);
}

const creds = { apiKey: "k" };

beforeEach(() => fetchMock.mockReset());

describe("D2A combo-aware retry budget (comboFallbackRemaining)", () => {
  it("503 with combo fallback remaining: 0 executor retries, response returned immediately", async () => {
    const ex = makeExec({ baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res(503, '{"error":{"message":"overloaded"}}'));
    const out = await ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      comboFallbackRemaining: true,
    });
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("503 without combo (direct model): full retry budget preserved", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 3, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(503, '{"error":{"message":"overloaded"}}'));
    const out = await ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      comboFallbackRemaining: false,
    });
    // 1 initial + 3 retries
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("502 with combo fallback remaining: bounded to 1 retry (network blip still recoverable)", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 3, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(502, "bad gateway"));
    const out = await ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      comboFallbackRemaining: true,
    });
    expect(out.response.status).toBe(502);
    // 1 initial + 1 retry (combo budget min(3, 1) = 1)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("combo budget never increases provider-configured attempts", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 502: { attempts: 0, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(502, "bad gateway"));
    const out = await ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      comboFallbackRemaining: true,
    });
    // provider says 0; combo budget min(0, 1) = 0 — never increased
    expect(out.response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("D2A reason-aware retry gate (error-body classification)", () => {
  it("503 with structured quota body: 0 retries even without combo", async () => {
    const ex = makeExec({ baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res(503, '{"error":{"message":"You exceeded your current quota"}}'));
    const out = await ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      comboFallbackRemaining: false,
    });
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("503 with FreeTierError body: 0 retries", async () => {
    const ex = makeExec({ baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res(503, '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}'));
    const out = await ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      comboFallbackRemaining: false,
    });
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bare 503 with no recognizable markers: retry budget kept", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 3, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(503, ""));
    const out = await ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      comboFallbackRemaining: false,
    });
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 + 3 retries
  });

  it("401 auth body: 0 retries", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 401: { attempts: 3, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(401, '{"error":{"message":"invalid api key"}}'));
    const out = await ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
    });
    expect(out.response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("unreadable body: fail-open keeps status-based retry", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 1, delayMs: 0 } } });
    const broken = {
      status: 503,
      headers: { get: () => "" },
      clone() {
        return {
          body: {
            getReader: () => ({
              read: async () => { throw new Error("decode failed"); },
              cancel: async () => {},
            }),
          },
        };
      },
    };
    fetchMock.mockResolvedValue(broken);
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 + 1 retry (fail-open)
  });

  it("malformed JSON body: classification does not crash, retry kept", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 1, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(503, "{not json"));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 + 1 retry (no markers found)
  });
});

describe("D2A bounded structured-error inspection", () => {
  const quotaBody = JSON.stringify({ error: { message: "You exceeded your current quota" } });

  it("small structured error body: marker seen, 0 retries", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 3, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(503, quotaBody));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("oversized body with marker within first 64KB: still vetoes retries", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 3, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(503, quotaBody + "y".repeat(2 * 1024 * 1024)));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marker beyond the 64KB peek window: not seen, status-based retry kept", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 1, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(503, "x".repeat(70 * 1024) + quotaBody));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 + 1 retry (fail-open beyond cap)
  });

  it("non-terminating error stream: inspection stalls at 500ms, fallback still proceeds", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 1, delayMs: 0 } } });
    const hangingBody = () => new ReadableStream({ pull() { return new Promise(() => {}); } });
    fetchMock.mockImplementation(() => Promise.resolve(new Response(hangingBody(), { status: 503 })));
    const t0 = Date.now();
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    const elapsed = Date.now() - t0;
    expect(out.response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2); // stall → fail-open → 1 retry, then attempts exhausted
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(4000);
  }, 10000);

  it("client abort during bounded inspection: no retry dispatch, no long sleep", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 3, delayMs: 10000 } } });
    const hangingBody = () => new ReadableStream({ pull() { return new Promise(() => {}); } });
    fetchMock.mockImplementation(() => Promise.resolve(new Response(hangingBody(), { status: 503 })));
    const ctrl = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ctrl.abort(), 30);
    await expect(ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      signal: ctrl.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    const elapsed = Date.now() - t0;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(3000); // abort cut the 500ms stall and the 10s backoff
  }, 10000);

  it("original response stays fully readable after bounded peek", async () => {
    const ex = makeExec({ baseUrl: "https://x/api" });
    const body = quotaBody + "y".repeat(2 * 1024 * 1024);
    fetchMock.mockResolvedValue(res(503, body));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(fetchMock).toHaveBeenCalledTimes(1); // peek vetoes
    const text = await out.response.text();
    expect(text.length).toBe(body.length); // full body, not the 64KB peek window
    expect(text).toBe(body);
  });
});

describe("D2A fallback availability (live predicate)", () => {
  function wireExec(seen) {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 3, delayMs: 0 } } });
    return async (_b, model, _p, options = {}) => {
      seen.push({ model, flag: options.comboFallbackRemaining });
      const out = await ex.execute({
        model, body: {}, stream: false, credentials: creds,
        comboFallbackRemaining: options.comboFallbackRemaining,
      });
      return out.response;
    };
  }

  it("hooks present + healthy later candidate: capacity budget applies (1 dispatch for failing m1)", async () => {
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const seen = [];
    fetchMock
      .mockResolvedValueOnce(res(503, ""))
      .mockResolvedValueOnce(res(200, "ok"));
    const out = await handleComboChat({
      body: {}, models: ["a/m1", "b/m2"], comboName: "t", comboStrategy: "fallback",
      beforeModelAttempt: async () => ({ skip: false }),
      handleSingleModel: wireExec(seen),
      log: { info() {}, warn() {}, debug() {} },
    });
    expect(out.status).toBe(200);
    expect(seen[0].flag).toBeTypeOf("function");
    expect(await seen[0].flag()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); // m1 cut to 1 dispatch, m2 succeeds
  });

  it("all later candidates skipped at execution: full budget restored (no fallback left)", async () => {
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const seen = [];
    let inspectOnlyCalls = 0;
    fetchMock.mockImplementation(() => Promise.resolve(res(503, "")));
    await handleComboChat({
      body: {}, models: ["a/m1", "b/m2"], comboName: "t", comboStrategy: "fallback",
      beforeModelAttempt: async (model, opts = {}) => {
        if (model === "b/m2") {
          if (opts.inspectOnly) {
            inspectOnlyCalls += 1;
            if (inspectOnlyCalls > 1) return { skip: true }; // healthy at plan, cooling at execution
            return { skip: false };
          }
          return { skip: true }; // loop attempt also skipped
        }
        return { skip: false };
      },
      handleSingleModel: wireExec(seen),
      log: { info() {}, warn() {}, debug() {} },
    });
    expect(await seen[0].flag()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4); // m1 full budget 1+3; m2 never dispatched
  });

  it("all later candidates skipped at plan: last eligible candidate gets full budget (boolean)", async () => {
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const seen = [];
    fetchMock.mockImplementation(() => Promise.resolve(res(503, "")));
    await handleComboChat({
      body: {}, models: ["a/m1", "b/m2"], comboName: "t", comboStrategy: "fallback",
      beforeModelAttempt: async (model) => (model === "b/m2" ? { skip: true } : { skip: false }),
      handleSingleModel: wireExec(seen),
      log: { info() {}, warn() {}, debug() {} },
    });
    expect(seen[0].flag).toBe(false); // boolean, not predicate — plan already excluded m2
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("predicate errors fail open: capacity budget kept (combo dispatches the candidate regardless)", async () => {
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const seen = [];
    fetchMock.mockImplementation(() => Promise.resolve(res(503, "")));
    await handleComboChat({
      body: {}, models: ["a/m1", "b/m2"], comboName: "t", comboStrategy: "fallback",
      beforeModelAttempt: async (model, opts = {}) => {
        if (model === "b/m2" && opts.inspectOnly) throw new Error("health store unavailable");
        return { skip: false };
      },
      handleSingleModel: wireExec(seen),
      log: { info() {}, warn() {}, debug() {} },
    });
    expect(await seen[0].flag()).toBe(true); // predicate error → fallback exists → budget cut
    expect(fetchMock).toHaveBeenCalledTimes(5); // m1 capped to 1; m2 (no later candidate) keeps full 1+3
  });

  it("fusion omits comboFallbackRemaining (deliberate: panel calls keep full budget)", async () => {
    const { handleFusionChat } = await import("../../open-sse/services/combo.js");
    const seen = [];
    const out = await handleFusionChat({
      body: { messages: [{ role: "user", content: "q" }] },
      models: ["p/a"],
      handleSingleModel: async (_b, _m, _panel, options = {}) => {
        seen.push(options.comboFallbackRemaining);
        return new Response("ok", { status: 200 });
      },
      log: { info() {}, warn() {}, debug() {} },
      tuning: { stragglerGraceMs: 1 },
    });
    expect(out.status).toBe(200);
    expect(seen).toEqual([undefined]);
  });
});

describe("D2A cancellation-aware backoff", () => {
  it("abort during retry backoff stops immediately without re-dispatch", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 3, delayMs: 30000 } } });
    fetchMock.mockResolvedValue(res(503, ""));
    const ctrl = new AbortController();
    const t0 = Date.now();
    // abort mid-backoff
    setTimeout(() => ctrl.abort(), 50);
    await expect(ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      signal: ctrl.signal,
      comboFallbackRemaining: false,
    })).rejects.toMatchObject({ name: "AbortError" });
    const elapsed = Date.now() - t0;
    // cancellation surfaces as AbortError rather than sleeping out 30s
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("D2A FreeTierError classification", () => {
  it("classifies FreeTierError as capability, chainable, with route cooldown", () => {
    const c = classifyRouteFailure(403, '{"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode. Please upgrade to a paid plan."}}');
    expect(c.reason).toBe("capability");
    expect(c.scope).toBe("credential");
    expect(c.chainable).toBe(true); // combo must still fall through to next candidate
    expect(c.routeCooldownMs).toBeGreaterThan(0);
    expect(isRouteHealthRelevant(c)).toBe(true); // capability failures feed route health
  });

  it("unrelated 403 without capability markers stays unknown/chainable", () => {
    const c = classifyRouteFailure(403, '{"error":{"message":"forbidden by policy"}}');
    expect(c.chainable).toBe(true);
    expect(c.reason).not.toBe("capability");
  });

  it("401 with capability marker still classifies authentication (auth branch checked first for 401)", () => {
    // 401 path: capability markers checked first in the 401/403 branch
    const c = classifyRouteFailure(401, "unauthorized invalid api key");
    expect(c.reason).toBe("authentication");
    expect(c.chainable).toBe(true);
  });
});

describe("D2A combo threads comboFallbackRemaining to handleSingleModel", () => {
  it("passes comboFallbackRemaining=true for all but the last candidate", async () => {
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const seen = [];
    const mkRes = (status) => new Response(status === 200 ? "ok" : "err", { status });
    await handleComboChat({
      body: {},
      models: ["a/m1", "b/m2", "c/m3"],
      comboName: "t",
      comboStrategy: "fallback",
      handleSingleModel: async (_b, model, _p, options = {}) => {
        seen.push({ model, flag: options.comboFallbackRemaining });
        return model === "c/m3" ? mkRes(200) : mkRes(503);
      },
      log: { info() {}, warn() {}, debug() {} },
      requestSignal: null,
    });
    expect(seen).toEqual([
      { model: "a/m1", flag: true },
      { model: "b/m2", flag: true },
      { model: "c/m3", flag: false },
    ]);
  });

  it("single-candidate combo: comboFallbackRemaining=false throughout", async () => {
    const { handleComboChat } = await import("../../open-sse/services/combo.js");
    const seen = [];
    await handleComboChat({
      body: {},
      models: ["a/m1"],
      comboName: "t",
      comboStrategy: "fallback",
      handleSingleModel: async (_b, _m, _p, options = {}) => {
        seen.push(options.comboFallbackRemaining);
        return new Response("ok", { status: 200 });
      },
      log: { info() {}, warn() {}, debug() {} },
      requestSignal: null,
    });
    expect(seen).toEqual([false]);
  });
});

describe("D2A abort listener lifecycle (fake timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("abort during backoff: timer cleared, no re-dispatch, nothing left pending", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 3, delayMs: 5000 } } });
    fetchMock.mockImplementation(() => Promise.resolve(res(503, "")));
    const ctrl = new AbortController();
    const p = ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      signal: ctrl.signal, comboFallbackRemaining: false,
    });
    const rejection = expect(p).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0); // fetch + peek + backoff setup
    await vi.advanceTimersByTimeAsync(2500);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // backoff pending
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(0);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pre-aborted signal: no retry dispatch, no timer accumulation", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 3, delayMs: 5000 } } });
    fetchMock.mockImplementation(() => Promise.resolve(res(503, "")));
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      signal: ctrl.signal, comboFallbackRemaining: false,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("normal retry chain: abort listeners balanced (add == remove), chain completes", async () => {
    const ex = makeExec({ baseUrl: "https://x/api", retry: { 503: { attempts: 3, delayMs: 100 } } });
    fetchMock
      .mockResolvedValueOnce(res(503, ""))
      .mockResolvedValueOnce(res(503, ""))
      .mockResolvedValueOnce(res(503, ""))
      .mockResolvedValueOnce(res(200, "ok"));
    const ctrl = new AbortController();
    const sig = ctrl.signal;
    const addSpy = vi.spyOn(sig, "addEventListener");
    const removeSpy = vi.spyOn(sig, "removeEventListener");
    const p = ex.execute({
      model: "m", body: {}, stream: false, credentials: creds,
      signal: sig, comboFallbackRemaining: false,
    });
    await vi.advanceTimersByTimeAsync(1000); // through all 3 backoffs
    const out = await p;
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(addSpy.mock.calls.length).toBeGreaterThanOrEqual(6); // 3 peeks + 3 backoffs
    expect(addSpy.mock.calls.length).toBe(removeSpy.mock.calls.length);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("D2A capability cooldown isolation (route-scoped, bounded)", () => {
  const freeTierBody = JSON.stringify({
    type: "error",
    error: { type: "FreeTierError", message: "OpenCode's free tier can only be used from within OpenCode. Please upgrade to a paid plan." },
  });

  function healthStorage() {
    const values = {};
    return {
      async getAll() { return { ...values }; },
      async set(key, value) { values[key] = value; },
      async remove(key) { delete values[key]; },
      async clear() { for (const key of Object.keys(values)) delete values[key]; },
    };
  }

  it("capability failure on one route leaves other models/providers untouched", async () => {
    const { RouteHealthState } = await import("../../open-sse/services/routeHealthState.js");
    const state = new RouteHealthState(healthStorage());
    const now = Date.parse("2026-10-14T00:00:00.000Z");
    const classification = classifyRouteFailure(403, freeTierBody);
    expect(classification.reason).toBe("capability");
    await state.recordFailure("oc/muse-free", classification, null, now);
    expect((await state.inspect("oc/muse-free", now + 1000)).skip).toBe(true);
    expect((await state.inspect("oc/mimo-v2.5-free", now + 1000)).skip).toBe(false);
    expect((await state.inspect("oc/go-model", now + 1000)).skip).toBe(false);
    expect((await state.inspect("gemini/gemini-2.5-pro", now + 1000)).skip).toBe(false);
  });

  it("capability cooldown is bounded and expires into a half-open probe", async () => {
    const { RouteHealthState } = await import("../../open-sse/services/routeHealthState.js");
    const state = new RouteHealthState(healthStorage());
    const now = Date.parse("2026-10-14T00:00:00.000Z");
    const classification = classifyRouteFailure(403, freeTierBody);
    await state.recordFailure("oc/muse-free", classification, null, now);
    expect(classification.routeCooldownMs).toBeGreaterThan(0);
    expect(classification.routeCooldownMs).toBeLessThanOrEqual(30 * 60_000); // never permanent
    const deadline = now + classification.routeCooldownMs;
    expect((await state.beforeAttempt("oc/muse-free", deadline - 1)).skip).toBe(true);
    const probe = await state.beforeAttempt("oc/muse-free", deadline + 1);
    expect(probe.probe).toBe(true);
    await state.recordSuccess("oc/muse-free");
    expect((await state.inspect("oc/muse-free", deadline + 2)).skip).toBe(false);
  });
});
