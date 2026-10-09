import { RouteHealthState } from "open-sse/services/routeHealthState.js";
import { classifyRouteFailure, isRouteHealthRelevant } from "open-sse/services/routeFailureClassifier.js";
import {
  getAllRouteHealth,
  setRouteHealth,
  removeRouteHealth,
  clearRouteHealth,
} from "@/lib/db/repos/routeHealthRepo.js";

const storage = {
  getAll: getAllRouteHealth,
  set: setRouteHealth,
  remove: removeRouteHealth,
  clear: clearRouteHealth,
};

const routeHealth = new RouteHealthState(storage);

function toBoundedIso(timestampMs) {
  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function parseRetryAfter(value) {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return toBoundedIso(Date.now() + Math.max(0, value) * 1000);
  }
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    return toBoundedIso(Date.now() + Number(text) * 1000);
  }
  const parsed = new Date(text).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function beforeRouteAttempt(model, now) {
  return routeHealth.beforeAttempt(model, now);
}

export async function inspectRouteHealth(model, now) {
  await routeHealth.hydrate();
  return routeHealth.inspect(model, now);
}

export async function recordRouteFailure(model, { status, errorText, retryAfter } = {}, now = Date.now(), probeToken = null) {
  const snapshot = await routeHealth.snapshot();
  const previousLevel = snapshot[model]?.failureCount || 0;
  const classification = classifyRouteFailure(status, errorText, previousLevel);
  if (!isRouteHealthRelevant(classification)) {
    return { classification, record: null };
  }
  const retryAt = parseRetryAfter(retryAfter);
  const record = await routeHealth.recordFailure(
    model,
    classification,
    retryAt,
    now,
    errorText,
    probeToken,
  );
  return { classification, record };
}

export function recordRouteSuccess(model, probeToken = null) {
  return routeHealth.recordSuccess(model, probeToken);
}

export function cancelRouteAttempt(model, probeToken = null) {
  return routeHealth.cancelProbe(model, probeToken);
}

export function getRouteHealthSnapshot() {
  return routeHealth.snapshot();
}

export function flushRouteHealthPersistence() {
  return routeHealth.flush();
}

export function clearAllRouteHealth() {
  return routeHealth.clear();
}
