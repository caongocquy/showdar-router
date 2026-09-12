import {
  beforeRouteAttempt,
  inspectRouteHealth,
  recordRouteFailure,
  recordRouteSuccess,
  cancelRouteAttempt,
  getRouteHealthSnapshot,
} from "./routeHealth.js";
import { validateChatComboResponse } from "open-sse/services/chatComboResponseValidator.js";

function formatWait(nextProbeAt) {
  if (!nextProbeAt) return "later";
  const diffMs = new Date(nextProbeAt).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "now";
  const seconds = Math.ceil(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m`;
}

export function createChatComboHealthHooks(log) {
  return {
    inspectModel(model) {
      return inspectRouteHealth(model);
    },
    async beforeModelAttempt(model, options = {}) {
      const decision = options.inspectOnly
        ? await inspectRouteHealth(model)
        : await beforeRouteAttempt(model);
      if (decision.skip) {
        log.info("ROUTE", `${model} healthy → ${decision.reason || "unhealthy"} · skip, probe in ${formatWait(decision.nextProbeAt)}`);
      } else if (decision.probe && !options.inspectOnly) {
        log.info("ROUTE", `${model} cooldown → half_open`);
      }
      return decision;
    },

    async onModelSuccess(model) {
      const snapshot = await getRouteHealthSnapshot();
      const wasRecovering = !!snapshot[model];
      await recordRouteSuccess(model);
      if (wasRecovering) {
        log.info("ROUTE", `${model} half_open → healthy`);
      }
    },

    async onModelFailure(model, failure) {
      const { classification, record } = await recordRouteFailure(model, failure);
      if (!record) return;
      log.info("ROUTE", `${model} healthy → ${classification.reason} · ${record.state}, probe in ${formatWait(record.nextProbeAt)}`);
    },

    async onModelCancelled(model) {
      await cancelRouteAttempt(model);
    },

    validateSuccess: validateChatComboResponse,
  };
}
