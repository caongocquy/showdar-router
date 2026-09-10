import { BACKOFF_CONFIG, ROUTE_HEALTH_CONFIG } from "../config/errorConfig.js";

const UNSUPPORTED_MODEL_MARKERS = [
  "model is not supported",
  "model not supported",
  "is not supported",
  "unsupported model",
  "model_not_supported",
  "does not support model",
];

const AUTH_MARKERS = [
  "invalid api key",
  "invalid_api_key",
  "unauthorized",
  "authentication failed",
  "expired token",
  "invalid token",
];

const QUOTA_MARKERS = [
  "rate limit",
  "too many requests",
  "quota exceeded",
  "exceeded your current quota",
  "free-models-per-day",
  "usage limit",
];

const CAPACITY_MARKERS = ["capacity", "overloaded", "temporarily unavailable"];
const TIMEOUT_MARKERS = ["timeout", "timed out", "operation was aborted", "aborted"];
const NETWORK_MARKERS = ["econnreset", "econnrefused", "enotfound", "fetch failed", "network"];

function lowerText(errorText) {
  if (!errorText) return "";
  if (typeof errorText === "string") return errorText.toLowerCase();
  try { return JSON.stringify(errorText).toLowerCase(); } catch { return String(errorText).toLowerCase(); }
}

export function extractEffectiveStatus(status, errorText) {
  const outer = Number(status) || 0;
  const text = lowerText(errorText);
  if (![500, 502, 503, 504].includes(outer)) return outer;

  const bracket = text.match(/\[(4\d\d|5\d\d)\]\s*:/);
  if (bracket) return Number(bracket[1]);

  const jsonStatus = text.match(/"(?:status|code)"\s*:\s*(4\d\d|5\d\d)/);
  if (jsonStatus) return Number(jsonStatus[1]);

  return outer;
}

function includesAny(text, markers) {
  return markers.some((marker) => text.includes(marker));
}

function exponential(baseMs, maxMs, failureLevel = 0) {
  const level = Math.max(0, Number(failureLevel) || 0);
  return Math.min(baseMs * (2 ** level), maxMs);
}

export function classifyRouteFailure(status, errorText, failureLevel = 0) {
  const text = lowerText(errorText);
  const effectiveStatus = extractEffectiveStatus(status, errorText);
  let reason = "unknown";
  let scope = "route";

  if (includesAny(text, UNSUPPORTED_MODEL_MARKERS) || effectiveStatus === 406) {
    reason = "unsupported_model";
  } else if (effectiveStatus === 404) {
    reason = "model_not_found";
  } else if (effectiveStatus === 429 || includesAny(text, QUOTA_MARKERS)) {
    reason = "quota";
    scope = "credential";
  } else if (effectiveStatus === 402 || text.includes("subscription") || text.includes("payment required")) {
    reason = "subscription";
    scope = "credential";
  } else if (effectiveStatus === 401 || effectiveStatus === 403) {
    if (includesAny(text, AUTH_MARKERS) || effectiveStatus === 401) {
      reason = "authentication";
      scope = "credential";
    }
  } else if ([400, 405, 409, 413, 415, 422].includes(effectiveStatus)) {
    reason = "request";
    scope = "request";
  } else if (includesAny(text, TIMEOUT_MARKERS) || effectiveStatus === 504) {
    reason = "timeout";
  } else if (includesAny(text, NETWORK_MARKERS)) {
    reason = "network";
  } else if (includesAny(text, CAPACITY_MARKERS) || effectiveStatus === 502 || effectiveStatus === 503) {
    reason = "provider_capacity";
  }

  const routePolicy = scope === "request"
    ? { baseMs: 0, maxMs: 0, state: null }
    : (ROUTE_HEALTH_CONFIG[reason] || ROUTE_HEALTH_CONFIG.unknown);
  const routeCooldownMs = exponential(routePolicy.baseMs, routePolicy.maxMs, failureLevel);

  let credentialCooldownMs = 0;
  if (scope === "credential") {
    if (reason === "quota") {
      credentialCooldownMs = Math.min(
        BACKOFF_CONFIG.base * (2 ** Math.max(0, failureLevel)),
        BACKOFF_CONFIG.max,
      );
    } else {
      credentialCooldownMs = 2 * 60_000;
    }
  }

  return {
    effectiveStatus,
    scope,
    reason,
    routeReason: reason,
    routeState: routePolicy.state,
    routeCooldownMs,
    credentialCooldownMs,
  };
}

export function isRouteHealthRelevant(classification) {
  return classification?.scope !== "request";
}
