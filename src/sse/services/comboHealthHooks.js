import {
  beforeRouteAttempt,
  recordRouteFailure,
  recordRouteSuccess,
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
    async beforeModelAttempt(model) {
      const decision = await beforeRouteAttempt(model);
      if (decision.skip) {
        log.info("COMBO", `skip ${model} — ${decision.reason || "unhealthy"}, probe in ${formatWait(decision.nextProbeAt)}`);
      } else if (decision.probe) {
        log.info("COMBO", `probe ${model} — half-open`);
      }
      return decision;
    },

    async onModelSuccess(model) {
      const snapshot = await getRouteHealthSnapshot();
      const wasRecovering = !!snapshot[model];
      await recordRouteSuccess(model);
      if (wasRecovering) log.info("COMBO", `recover ${model}`);
    },

    async onModelFailure(model, failure) {
      const { classification, record } = await recordRouteFailure(model, failure);
      if (!record) return;
      log.info(
        "COMBO",
        `${record.state === "open" ? "open" : "cooldown"} ${model} — ${classification.reason}, probe in ${formatWait(record.nextProbeAt)}`,
      );
    },

    validateSuccess: validateChatComboResponse,
  };
}
