import { getCapabilitiesForModel } from "../providers/capabilities.js";

const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);

function splitModel(value) {
  const slash = typeof value === "string" ? value.indexOf("/") : -1;
  return slash > 0 ? [value.slice(0, slash), value.slice(slash + 1)] : ["", value];
}

export async function planComboCandidates({ models, requiredCapabilities = new Set(), inspectHealth = async () => ({ skip: false }), getCapabilities = getCapabilitiesForModel, latencyTrace = null }) {
  const required = [...requiredCapabilities];
  const hard = required.filter((cap) => HARD_CAPS.has(cap));
  const planned = [];
  const skipped = [];
  const list = Array.isArray(models) ? models : [];

  for (let i = 0; i < list.length; i++) {
    const model = list[i];
    const [provider, name] = splitModel(model);
    const caps = getCapabilities(provider, name) || {};
    if (!hard.every((cap) => caps[cap] === true)) {
      // Phase D1: candidate recorded but ineligible — never dispatched.
      latencyTrace?.planCandidate(i, model, { eligible: false });
      continue;
    }
    let health;
    try { health = await inspectHealth(model); } catch { health = { skip: false }; }
    if (health?.skip) {
      latencyTrace?.planCandidate(i, model, { eligible: true, healthSkip: true, healthSkipReason: health.reason || "route unhealthy" });
      skipped.push({ model, nextProbeAt: health.nextProbeAt || null });
      continue;
    }
    latencyTrace?.planCandidate(i, model, { eligible: true, healthSkip: false });
    planned.push(model);
  }

  return {
    models: planned,
    missingCapabilities: planned.length === 0 && skipped.length === 0 ? hard : [],
    skipped,
    routeUnavailable: planned.length === 0 && skipped.length > 0,
  };
}
