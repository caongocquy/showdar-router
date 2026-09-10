const MAX_METADATA_DELAY_MS = 24 * 60 * 60 * 1000;

function asFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function clampFuture(timestamp, now) {
  if (!Number.isFinite(timestamp) || timestamp <= now) return null;
  return Math.min(timestamp, now + MAX_METADATA_DELAY_MS);
}

function parseAbsolute(value, now) {
  if (value == null) return null;
  const numeric = asFiniteNumber(value);
  if (numeric != null) {
    // Epoch milliseconds or seconds. Small numbers are not treated as absolute timestamps.
    if (numeric > 1e12) return clampFuture(numeric, now);
    if (numeric > 1e9) return clampFuture(numeric * 1000, now);
    return null;
  }
  const parsed = Date.parse(String(value));
  return clampFuture(parsed, now);
}

function parseDuration(value, now) {
  if (value == null) return null;
  const numeric = asFiniteNumber(value);
  if (numeric != null) return clampFuture(now + Math.max(0, numeric) * 1000, now);

  const text = String(value).trim().toLowerCase();
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith("ms") ? 1
    : (unit.startsWith("s") ? 1000
      : (unit.startsWith("m") ? 60_000 : 3_600_000));
  return clampFuture(now + Math.round(amount * multiplier), now);
}

function toIso(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function findStructuredRetry(value, now, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStructuredRetry(item, now, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;

  // Absolute reset timestamps are stronger than relative hints at the same structure level.
  const absoluteKeys = ["resetAt", "reset_at", "resetsAt", "resets_at", "resetTime", "reset_time"];
  for (const key of absoluteKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const parsed = parseAbsolute(value[key], now);
      if (parsed) return parsed;
    }
  }

  const retryKeys = ["retryAfter", "retry_after", "retryDelay", "retry_delay"];
  for (const key of retryKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const raw = value[key];
    const absolute = parseAbsolute(raw, now);
    if (absolute) return absolute;
    const duration = parseDuration(raw, now);
    if (duration) return duration;
  }

  for (const child of Object.values(value)) {
    const found = findStructuredRetry(child, now, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseRetryAfterHeader(value, now) {
  if (value == null || String(value).trim() === "") return null;
  const numeric = asFiniteNumber(value);
  if (numeric != null) return clampFuture(now + Math.max(0, numeric) * 1000, now);
  return parseAbsolute(value, now);
}

function parseTextRetry(errorText, now) {
  if (!errorText) return null;
  const text = typeof errorText === "string" ? errorText : JSON.stringify(errorText);

  // Common human provider messages, e.g. "Please retry in 42.482s".
  const human = text.match(/(?:please\s+)?retry\s+in\s+([0-9]+(?:\.[0-9]+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?)/i);
  if (human) return parseDuration(`${human[1]}${human[2]}`, now);

  // Structured metadata often survives as embedded JSON inside a wrapped error string.
  const retryDelay = text.match(/["']retry(?:Delay|_delay)["']\s*:\s*["']?([0-9]+(?:\.[0-9]+)?\s*(?:ms|s|m|h))["']?/i);
  if (retryDelay) return parseDuration(retryDelay[1], now);

  const retryAfter = text.match(/["']retry(?:After|_after)["']\s*:\s*["']([^"']+)["']/i);
  if (retryAfter) {
    return parseAbsolute(retryAfter[1], now) || parseDuration(retryAfter[1], now);
  }

  return null;
}

/**
 * Resolve the best upstream recovery deadline.
 * Precedence: explicit reset timestamp -> Retry-After header -> structured body -> human/error text.
 * Returns an ISO timestamp or null when no trustworthy metadata exists.
 */
export function extractRetryDeadline({
  resetAt = null,
  retryAfterHeader = null,
  errorBody = null,
  errorText = null,
  now = Date.now(),
} = {}) {
  const explicitReset = parseAbsolute(resetAt, now);
  if (explicitReset) return toIso(explicitReset);

  const headerDeadline = parseRetryAfterHeader(retryAfterHeader, now);
  if (headerDeadline) return toIso(headerDeadline);

  const bodyDeadline = findStructuredRetry(errorBody, now);
  if (bodyDeadline) return toIso(bodyDeadline);

  const textDeadline = parseTextRetry(errorText, now);
  if (textDeadline) return toIso(textDeadline);

  return null;
}
