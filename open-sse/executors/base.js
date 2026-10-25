import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { noteRetryDispatch } from "../utils/latencyTrace.js";
import { dbg } from "../utils/debugLog.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../providers/shared.js";
import { resolveOpenAICompatibleApiType } from "../services/provider.js";
import { classifyRouteFailure } from "../services/routeFailureClassifier.js";

// Phase D2A: when combo has remaining candidates, capacity statuses fall
// through immediately (no executor retry). Network-mapped 502 keeps one
// retry for transient blips; 504 keeps one. This bounds per-candidate wall
// to ~first-upstream-RTT instead of 6-9s of futile retries before fallback.
const COMBO_CAPACITY_RETRY_OVERRIDES = {
  [HTTP_STATUS.SERVICE_UNAVAILABLE]: { attempts: 0, delayMs: 0 },
  [HTTP_STATUS.BAD_GATEWAY]: { attempts: 1, delayMs: 1000 },
  [HTTP_STATUS.GATEWAY_TIMEOUT]: { attempts: 1, delayMs: 1000 },
};

// Phase D2A: deterministic failures that never recover by re-invoking the
// same URL/account — combo/account fallback owns advancing past them.
const DETERMINISTIC_REASONS = new Set([
  "authentication", "capability", "subscription", "daily_quota",
  "quota", "transient_rate_limit",
  "unsupported_model", "model_not_found",
]);

// Phase D2A safety bounds for the classification peek: byte cap + stall
// deadline (mirrors kiro's readResponsePrefix idiom). Every shortfall
// (no body, stalled stream, abort, undecodable bytes) yields "" and the
// caller fails open to status-based retry. Body text never enters logs.
const PEEK_MAX_BYTES = 64 * 1024;
const PEEK_STALL_MS = 500;
const PEEK_STOP = Symbol("d2a-peek-stop");

async function peekErrorText(response, signal) {
  if (!response || typeof response.clone !== "function") return "";
  let clone;
  try {
    clone = response.clone();
  } catch {
    return "";
  }
  const reader = clone?.body?.getReader?.();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  let stallTimer = null;
  let abortHandler = null;
  const stallPromise = new Promise((resolve) => {
    stallTimer = setTimeout(() => resolve(PEEK_STOP), PEEK_STALL_MS);
  });
  let abortPromise = new Promise(() => {});
  if (signal?.aborted) {
    abortPromise = Promise.resolve(PEEK_STOP);
  } else if (signal) {
    abortPromise = new Promise((resolve) => {
      abortHandler = () => resolve(PEEK_STOP);
      signal.addEventListener("abort", abortHandler, { once: true });
    });
  }
  try {
    while (totalBytes < PEEK_MAX_BYTES) {
      const next = await Promise.race([
        reader.read(),
        stallPromise,
        abortPromise,
      ]);
      if (next === PEEK_STOP || next?.done) break;
      const chunk = next.value;
      if (!chunk?.byteLength) continue;
      const remaining = PEEK_MAX_BYTES - totalBytes;
      const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      totalBytes += slice.byteLength;
      text += decoder.decode(slice, { stream: true });
      if (chunk.byteLength > remaining) break;
    }
  } catch {
    return "";
  } finally {
    clearTimeout(stallTimer);
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
    // Fire-and-forget: never await clone cancellation (a stalled upstream
    // cancel must not delay fallback). Cancelling releases the tee branch;
    // the original response keeps its full buffered body readable.
    reader.cancel("bounded D2A classification peek").catch(() => {});
  }
  return text;
}

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const path = resolveOpenAICompatibleApiType(this.provider, credentials) === "responses" ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials(this.provider, credentials);
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, comboFallbackRemaining = false }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};

    // Phase D2A: provider retry config is never increased — only min-capped
    // by the combo capacity budget, and resolved LIVE at each retry (a
    // fallback candidate that disappears mid-request restores the provider's
    // own budget; one that appears stops futile same-URL retries).
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    const resolveComboBudgetRemaining = async () => {
      if (typeof comboFallbackRemaining !== "function") return !!comboFallbackRemaining;
      try {
        return !!(await comboFallbackRemaining());
      } catch {
        return true;
      }
    };

    // Schedule retry via retryConfig[statusKey]. Returns true when caller should `urlIndex--; continue`
    // response (optional) lets a subclass hook compute a dynamic delay (e.g. antigravity Retry-After).
    const tryRetry = async (urlIndex, statusKey, reason, response = null) => {
      let { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      const comboEntry = COMBO_CAPACITY_RETRY_OVERRIDES[statusKey];
      if (comboEntry && await resolveComboBudgetRemaining()) {
        const comboResolved = resolveRetryEntry(comboEntry);
        attempts = Math.min(attempts, comboResolved.attempts);
        delayMs = Math.min(delayMs, comboResolved.delayMs);
        if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      }
      // Phase D2A: reason-aware gate. Bounded peek (byte cap + stall deadline)
      // at the error body before retrying a status-based failure.
      // Deterministic failures will not recover by retrying the same URL —
      // skip executor retries so combo/account fallback advances immediately.
      // Fail-open on any peek shortfall (empty body, stalled stream, abort,
      // unreadable bytes) so a bare 5xx keeps its configured retry budget.
      if (response && typeof response.clone === "function") {
        try {
          const peek = await peekErrorText(response, signal);
          const classification = classifyRouteFailure(response.status, peek);
          if (classification.chainable === false) return false;
          if (DETERMINISTIC_REASONS.has(classification.reason)) return false;
        } catch { /* fail-open: unreadable body → keep status-based retry */ }
      }
      // Hook: subclass may derive delay from the response (headers/body). null → skip retry, use fallback.
      let waitMs = delayMs;
      if (response && this.computeRetryDelay) {
        const dynamic = await this.computeRetryDelay(response, retryAttemptsByUrl[urlIndex] + 1, delayMs);
        if (dynamic === false) return false; // hook vetoes retry (e.g. Retry-After too long)
        if (dynamic != null) waitMs = dynamic;
      }
      retryAttemptsByUrl[urlIndex]++;
      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${waitMs / 1000}s`);
      // Phase D2A: cancellation-aware backoff with guaranteed listener/timer
      // cleanup on every path (abort, normal expiry) — no leaked abort
      // listeners across the retry loop.
      if (waitMs > 0) {
        await new Promise(resolve => {
          let onAbort = null;
          const done = () => {
            clearTimeout(timer);
            if (onAbort) signal.removeEventListener("abort", onAbort);
            resolve();
          };
          const timer = setTimeout(done, waitMs);
          if (signal?.aborted) { done(); return; }
          if (signal) {
            onAbort = () => done();
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      }
      // A cancelled request terminates here: returning the failed response
      // would record it as a provider failure and cooldown the credential.
      if (signal?.aborted) throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
      // Phase D1: retry will re-dispatch on the same attempt (counted, not a new attempt).
      noteRetryDispatch();
      return true;
    };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials);
      const transformedBody = this.transformRequest(model, body, stream, credentials);
      const headers = this.buildHeaders(credentials, stream, url, model);

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      // Abort if upstream doesn't return response headers within connection timeout
      const connectCtrl = new AbortController();
      const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      try {
        const bodyStr = JSON.stringify(transformedBody);
        const fetchT0 = Date.now();
        dbg("FETCH", `${this.provider.toUpperCase()} → ${url} | body=${bodyStr.length}B | connectTimeout=${timeoutMs}ms`);
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal: mergedSignal
        }, proxyOptions);
        clearTimeout(connectTimer);
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${Date.now() - fetchT0}ms | ct=${ct} | cl=${cl}`);

        if (await tryRetry(urlIndex, response.status, `status ${response.status}`, response)) { urlIndex--; continue; }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        return { response, url, headers, transformedBody };
      } catch (error) {
        clearTimeout(connectTimer);
        lastError = error;
        const isConnectTimeout = connectCtrl.signal.aborted && error.name === "AbortError";
        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${error.name}: ${error.message}${isConnectTimeout ? " (connect timeout)" : ""}`);
        // Connect timeout is internal — convert to retryable network error, don't propagate AbortError
        if (error.name === "AbortError" && !isConnectTimeout) throw error;

        // Map network/fetch exceptions to 502 retry config
        if (await tryRetry(urlIndex, HTTP_STATUS.BAD_GATEWAY, `network "${error.message}"`)) { urlIndex--; continue; }

        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        // Internal connect timeout is a provider failure (502), never a client
        // AbortError: the caller must retry/fall back and may cooldown.
        if (isConnectTimeout) throw Object.assign(new Error(`fetch connect timeout after ${timeoutMs}ms`), { name: "TimeoutError", status: HTTP_STATUS.BAD_GATEWAY, cause: error });
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
