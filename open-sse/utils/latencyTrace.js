// Phase D1 — request-local latency observability. OPT-IN only:
// SHOWDAR_ROUTER_LATENCY_TRACE=1 enables one "[showdar-latency] {json}" line
// per request on stderr. Disabled = createLatencyTrace() returns null and every
// call site becomes a no-op — zero state, zero ALS storage runs, zero emission.
//
// Observability-only contract:
//  - never mutates request/response bytes, ordering, retries, or routing;
//  - fail-open: every public method swallows its own errors;
//  - classified failure enums only — no raw error text, ids, keys or bodies.
import { AsyncLocalStorage } from "node:async_hooks";
import { LATENCY_TRACE_MAX_LABEL_LENGTH, LATENCY_TRACE_SCAN_BUFFER_LIMIT } from "../config/runtimeConfig.js";

const TRACE_PREFIX = "[showdar-latency] ";

const latencyTraceStorage = new AsyncLocalStorage();
const attemptStorage = new AsyncLocalStorage();

const defaultClock = () => performance.now();
let clockFn = defaultClock;

export function isLatencyTraceEnabled() {
  try { return process.env.SHOWDAR_ROUTER_LATENCY_TRACE === "1"; } catch { return false; }
}

// Test-only clock injection (unit tests); production keeps performance.now.
export function setLatencyClock(fn) {
  const prev = clockFn;
  clockFn = fn || defaultClock;
  return () => { clockFn = prev; };
}

export function getActiveLatencyTrace() {
  try { return latencyTraceStorage.getStore() || null; } catch { return null; }
}

export function getActiveAttempt() {
  try { return attemptStorage.getStore() || null; } catch { return null; }
}

// No storage.run when the carrier is null — the disabled path never touches ALS.
export function runWithLatencyTrace(trace, fn) {
  return trace ? latencyTraceStorage.run(trace, fn) : fn();
}

export function runWithAttempt(attempt, fn) {
  return attempt ? attemptStorage.run(attempt, fn) : fn();
}

// Dispatch-phase marker: chatCore wraps executor.execute() in this window so
// proxyFetch dispatches (upstream, auth retries) count while headroom/token-
// refresh/metadata fetches outside it stay invisible to the trace.
export function setExecutePhase(rec, on) {
  try { if (rec) rec.inExecute = !!on; } catch { /* fail-open */ }
}

// Called at proxyAwareFetch entry — the single funnel every upstream HTTP call
// passes through (global fetch is patched to it). Marks t2 once per request and
// dispatchedMs once per attempt.
export function noteUpstreamDispatch() {
  try {
    const rec = attemptStorage.getStore();
    if (!rec || !rec.inExecute) return;
    rec.networkAttempt = true;
    if (rec.dispatchedMs == null) rec.dispatchedMs = clockFn();
    latencyTraceStorage.getStore()?.markFirst("t2");
  } catch { /* fail-open */ }
}

// Executor-internal retry (base.js tryRetry) — counted on the attempt, never as
// a separate attempt/candidate.
export function noteRetryDispatch() {
  try {
    const rec = attemptStorage.getStore();
    if (rec && rec.inExecute) rec.retryDispatches++;
  } catch { /* fail-open */ }
}

// ---- byte-boundary marks (called from streamHandler with an explicit carrier) -

// First raw upstream body byte (t3) + first meaningful upstream SSE line (t3m).
// Explicit `lat = {trace, attempt}` carrier — stream callbacks never read ALS.
export function noteUpstreamChunk(lat, chunk) {
  try {
    if (!lat) return;
    const att = lat.attempt;
    if (!att || att.upstreamFirstByteMs == null) {
      if (att) att.upstreamFirstByteMs = clockFn();
      lat.trace?.markFirst("t3");
    }
    const s = att?.scannerUp;
    if (s && att.upstreamMeaningfulMs == null && s.push(chunk)) {
      att.upstreamMeaningfulMs = clockFn();
      lat.trace?.markFirst("t3m");
    }
  } catch { /* fail-open */ }
}

// First byte enqueued to the client (t4) + first meaningful client-bound line (t4m).
// Gated on streamReturned: before the handleChat wrapper hands the response off,
// an interposed combo/fusion validator is the reader — its pulls are not client
// bytes and must not stamp clientTtftMs.
export function noteClientChunk(lat, chunk) {
  try {
    if (!lat || lat.trace?.streamReturned !== true) return;
    const att = lat.attempt;
    if (!att || att.firstByteMs == null) {
      if (att) att.firstByteMs = clockFn();
      lat.trace?.markFirst("t4");
    }
    const s = att?.scannerDown;
    if (s && att.meaningfulMs == null && s.push(chunk)) {
      att.meaningfulMs = clockFn();
      lat.trace?.markFirst("t4m");
    }
  } catch { /* fail-open */ }
}

// Failure classification: enum only. Order matters — a 502 wrapping ETIMEDOUT
// must classify as timeout, a 499 is always cancelled.
export function classifyFailure({ status = null, errorText = "", aborted = false } = {}) {
  try {
    if (aborted || status === 499) return "cancelled";
    const text = typeof errorText === "string" ? errorText : "";
    if (/ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_CONNECT_TIMEOUT|fetch connect timeout|connect timeout|stream stall timeout/i.test(text)) return "timeout";
    if (status === 429 || status === 529 || /rate.?limit|too many requests/i.test(text)) return "rate_limited";
    if (status === 401 || status === 403) return "auth";
    if (Number.isFinite(status) && status >= 400 && status < 500) return "upstream_4xx";
    if (Number.isFinite(status) && status >= 500) return "upstream_5xx";
    if (/ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network error|UND_ERR_SOCKET/i.test(text)) return "network_error";
    return "unknown";
  } catch { return "unknown"; }
}

// Interval union of [{startMs, endMs}] — overlapping spans (concurrent fusion
// panels) contribute wall time once, never double-counted.
export function unionMs(spans) {
  try {
    const iv = (Array.isArray(spans) ? spans : [])
      .filter((s) => s && Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs >= s.startMs)
      .map((s) => [s.startMs, s.endMs])
      .sort((a, b) => a[0] - b[0]);
    if (iv.length === 0) return 0;
    let total = 0;
    let curStart = iv[0][0];
    let curEnd = iv[0][1];
    for (let i = 1; i < iv.length; i++) {
      const [s, e] = iv[i];
      if (s > curEnd) { total += curEnd - curStart; curStart = s; curEnd = e; }
      else if (e > curEnd) curEnd = e;
    }
    total += curEnd - curStart;
    return total;
  } catch { return 0; }
}

// ---- meaningful-content classification (first token ≠ first byte) ----------

function isMeaningfulJson(obj) {
  if (!obj || typeof obj !== "object") return false;
  // Human-text deltas: whitespace-only (" ") is padding, not a meaningful token.
  const hasText = (s) => typeof s === "string" && s.trim().length > 0;
  // OpenAI chat completion chunk
  const d = obj.choices?.[0]?.delta;
  if (d && typeof d === "object") {
    if (hasText(d.content)) return true;
    if (hasText(d.reasoning_content)) return true;
    if (hasText(d.reasoning)) return true;
    if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) return true;
  }
  // Anthropic-style content_block_delta
  if (obj.type === "content_block_delta" && obj.delta && typeof obj.delta === "object") {
    const dd = obj.delta;
    if (hasText(dd.text)) return true;
    if (hasText(dd.thinking)) return true;
    if (typeof dd.partial_json === "string" && dd.partial_json.length > 0) return true;
  }
  // OpenAI Responses-style deltas
  if ((obj.type === "response.output_text.delta" || obj.type === "response.text.delta")
    && hasText(obj.delta)) return true;
  if (obj.type === "response.reasoning_summary_text.delta" && hasText(obj.delta)) return true;
  // Gemini-style candidates
  const parts = obj.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      if (hasText(p.text)) return true;
      if (hasText(p.thinking)) return true;
    }
  }
  // Generic deltas
  if (hasText(obj.delta)) return true;
  if (hasText(obj.content)) return true;
  return false;
}

function isMeaningfulPayload(payload) {
  try { return isMeaningfulJson(JSON.parse(payload)); } catch { return false; }
}

// Bounded incremental SSE line scanner: buffers until a complete `data:` line
// can be classified, gives up (fail-open, "unavailable") past the cap. One
// instance per attempt per direction (upstream/downstream).
export function createMeaningfulScanner() {
  const decoder = new TextDecoder();
  let buf = "";
  let found = false;
  let released = false;
  return {
    push(chunk) {
      if (found || released) return false;
      try {
        const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        buf += text;
        if (buf.length > LATENCY_TRACE_SCAN_BUFFER_LIMIT) {
          released = true;
          buf = "";
          return false;
        }
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const rawLine = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          if (isMeaningfulPayload(payload)) {
            found = true;
            buf = "";
            return true;
          }
        }
        return false;
      } catch {
        released = true;
        buf = "";
        return false;
      }
    },
    release() { released = true; buf = ""; },
  };
}

// ---- trace ---------------------------------------------------------------

function round1(v) {
  return Math.round(v * 10) / 10;
}

// Labels are operator-facing, never payload: cap client-controlled strings so a
// single request cannot emit an unbounded trace line.
function boundLabel(v) {
  if (typeof v !== "string") return null;
  return v.length > LATENCY_TRACE_MAX_LABEL_LENGTH
    ? v.slice(0, LATENCY_TRACE_MAX_LABEL_LENGTH) + "…"
    : v;
}

function emit(trace, kind) {
  try {
    console.error(TRACE_PREFIX + JSON.stringify(buildPayload(trace, kind)));
  } catch { /* emission must never break the request */ }
}

function buildPayload(trace, kind) {
  const rel = (v) => (v == null ? null : round1(v - trace.t0));

  const attempts = trace.attempts.map((rec) => ({
    ordinal: rec.ordinal,
    model: boundLabel(rec.model),
    startMs: rel(rec.startMs),
    endMs: rel(rec.endMs),
    result: rec.result,
    reason: rec.reason == null ? null : boundLabel(rec.reason),
    status: rec.status,
    networkAttempt: !!rec.networkAttempt,
    dispatchedMs: rel(rec.dispatchedMs),
    upstreamFirstByteMs: rel(rec.upstreamFirstByteMs),
    upstreamMeaningfulMs: rel(rec.upstreamMeaningfulMs),
    firstByteMs: rel(rec.firstByteMs),
    meaningfulMs: rel(rec.meaningfulMs),
    retryDispatches: rec.retryDispatches | 0,
    authRefresh: !!rec.authRefresh,
    probe: !!rec.probe,
  }));

  const candidates = trace.candidates.map((c) => ({
    ordinal: c.ordinal,
    model: boundLabel(c.model),
    eligible: c.eligible !== false,
    healthSkip: !!c.healthSkip,
    healthSkipReason: c.healthSkip ? boundLabel(c.healthSkipReason || "route unhealthy") : null,
    networkAttempts: attempts.filter((a) => a.networkAttempt && a.ordinal === c.ordinal && a.model === c.model).length,
  }));

  const m = (key) => (trace.marks[key] != null ? trace.marks[key] : null);
  const diff = (a, b) => (a == null || b == null ? null : round1(a - b));
  const t1 = m("t1"); const t2 = m("t2"); const t3 = m("t3"); const t3m = m("t3m");
  const t4 = m("t4"); const t4m = m("t4m"); const t5 = m("t5");

  let winner = null;
  let winnerPayload = null;
  const wi = trace.winner ? trace.attempts.indexOf(trace.winner) : -1;
  if (wi >= 0) {
    winnerPayload = attempts[wi];
    const earlierNetwork = attempts.slice(0, wi).filter((a) => a.networkAttempt);
    let type = null;
    if (earlierNetwork.length === 0) {
      type = winnerPayload.networkAttempt ? "CLEAN_WINNER" : null;
    } else if (earlierNetwork.some((a) => a.result !== "success")) {
      type = "FALLBACK_WINNER";
    }
    winner = { ordinal: winnerPayload.ordinal, model: winnerPayload.model, type };
  }

  const stats = {
    selectionMs: t1 == null ? null : round1(t1),
    preDispatchMs: diff(t2, t1),
    upstreamTtfbMs: diff(t3, t2),
    upstreamFirstMeaningfulMs: diff(t3m, t2),
    proxyFirstByteDelayMs: diff(t4, t3),
    clientTtftMs: t4 == null ? null : round1(t4),
    totalMs: t5 == null ? null : round1(t5),
    fallbackAttempts: null,
    timeBeforeWinnerMs: null,
    failedAttemptWallMs: null,
    winnerUpstreamTtftMs: null,
  };

  if (wi >= 0) {
    const first = attempts[0];
    const pWin = attempts[wi];
    const earlierFailed = attempts.slice(0, wi).filter((a) => a.networkAttempt && a.result !== "success");
    stats.fallbackAttempts = earlierFailed.length;
    stats.timeBeforeWinnerMs = first && pWin && first.startMs != null && pWin.startMs != null
      ? round1(pWin.startMs - first.startMs) : null;
    const failedSpans = earlierFailed
      .filter((a) => a.startMs != null && a.endMs != null)
      .map((a) => ({ startMs: a.startMs, endMs: a.endMs }));
    stats.failedAttemptWallMs = round1(unionMs(failedSpans));
    stats.winnerUpstreamTtftMs = pWin && pWin.dispatchedMs != null && pWin.upstreamFirstByteMs != null
      ? round1(pWin.upstreamFirstByteMs - pWin.dispatchedMs) : null;
  }

  return {
    v: 1,
    kind,
    endpoint: boundLabel(trace.endpoint),
    marks: { t0: 0, t1, t2, t3, t3m, t4, t4m, t5 },
    combo: trace.combo ? { name: boundLabel(trace.combo.name), strategy: trace.combo.strategy ?? null } : null,
    candidates,
    attempts,
    winner,
    stats,
  };
}

/**
 * Create a request-local latency trace. Returns null when the env flag is off.
 * @param {object} [options]
 * @param {string|null} [options.endpoint] - URL pathname only (no query/headers).
 */
export function createLatencyTrace({ endpoint = null } = {}) {
  if (!isLatencyTraceEnabled()) return null;
  try {
    const now = () => clockFn();
    const t0 = now();
    const trace = {
      endpoint,
      t0,
      now,
      finalized: false,
      finalizeOnComplete: false,
      // Set by the handleChat wrapper when the terminal response is handed to
      // the client. Stream terminals (complete/error/disconnect) may only
      // finalize after this — before handoff, a combo/fusion validator reading
      // the attempt stream must never emit the request trace.
      streamReturned: false,
      marks: { t0: 0 },
      combo: null,
      comboActive: false,
      candidates: [],
      attempts: [],
      winner: null,

      // First-wins absolute marks, stored as offsets from t0.
      markFirst(key) {
        try {
          if (this.finalized || this.marks[key] != null) return;
          this.marks[key] = round1(now() - t0);
        } catch { /* fail-open */ }
      },

      // Combo/fusion selection complete (t1). First-wins; comboActive set here
      // tells handleSingleModelChat not to double-record solo attempts/t1.
      setCombo(name, strategy) {
        try {
          this.comboActive = true;
          if (!this.combo) this.combo = { name: name || null, strategy: strategy ?? null };
          this.markFirst("t1");
        } catch { /* fail-open */ }
      },

      markSoloSelection() {
        try { if (!this.comboActive) this.markFirst("t1"); } catch { /* fail-open */ }
      },

      findCandidate(ordinal, model) {
        return this.candidates.find((c) =>
          (ordinal >= 0 && c.ordinal === ordinal) ||
          (ordinal < 0 && c.ordinal < 0 && c.model === model)
        ) || null;
      },

      // Upsert keyed by configured ordinal (planner order). Idempotent so a
      // re-plan (fusion degrade → handleComboChat) never duplicates records.
      planCandidate(ordinal, model, info = {}) {
        try {
          let c = this.findCandidate(ordinal, model);
          if (!c) {
            c = { ordinal, model, eligible: true, healthSkip: false, healthSkipReason: null };
            this.candidates.push(c);
          }
          if (info.eligible != null) c.eligible = !!info.eligible;
          if (info.healthSkip != null) {
            c.healthSkip = !!info.healthSkip;
            c.healthSkipReason = info.healthSkip ? (info.healthSkipReason || info.reason || null) : null;
          }
          return c;
        } catch { return null; }
      },

      noteHealthSkip(model, ordinal, reason) {
        return this.planCandidate(ordinal, model, { healthSkip: true, healthSkipReason: reason || "route unhealthy" });
      },

      ensureCandidate(ordinal, model) {
        return this.planCandidate(ordinal, model, {});
      },

      beginAttempt({ ordinal = -1, model = null, probe = false } = {}) {
        try {
          const rec = {
            ordinal,
            model,
            probe: !!probe,
            startMs: now(),
            endMs: null,
            inExecute: false,
            networkAttempt: false,
            dispatchedMs: null,
            retryDispatches: 0,
            authRefresh: false,
            upstreamFirstByteMs: null,
            upstreamMeaningfulMs: null,
            firstByteMs: null,
            meaningfulMs: null,
            result: null,
            reason: null,
            status: null,
            scannerUp: createMeaningfulScanner(),
            scannerDown: createMeaningfulScanner(),
          };
          this.attempts.push(rec);
          this.ensureCandidate(ordinal, model);
          return rec;
        } catch { return null; }
      },

      // First finish wins; endMs = response accepted (headers) for streaming
      // winners — the stream terminal is t5, not the attempt end.
      finishAttempt(rec, { result = null, status = null, errorText = "", reason = null, aborted = false } = {}) {
        try {
          if (!rec || rec.result != null) return;
          rec.endMs = now();
          rec.result = result;
          rec.status = Number.isFinite(status) ? status : null;
          rec.reason = result === "success" ? null : (reason || classifyFailure({ status: rec.status, errorText, aborted }));
        } catch { /* fail-open */ }
      },

      noteWinner(rec) {
        try { if (rec) this.winner = rec; } catch { /* fail-open */ }
      },

      noteWinnerByModel(model) {
        try {
          const recs = this.attempts.filter((a) => a.model === model && a.result === "success");
          if (recs.length > 0) this.winner = recs[recs.length - 1];
        } catch { /* fail-open */ }
      },

      // Single emission per request (first-wins).
      finalize(kind) {
        try {
          if (this.finalized) return;
          this.finalized = true;
          this.marks.t5 = round1(now() - t0);
          const safeKind = kind === "cancelled" || kind === "failed" ? kind : "completed";
          emit(this, safeKind);
          for (const rec of this.attempts) {
            rec.scannerUp?.release?.();
            rec.scannerDown?.release?.();
            rec.scannerUp = null;
            rec.scannerDown = null;
          }
        } catch { /* fail-open */ }
      },
    };
    return trace;
  } catch {
    return null;
  }
}
