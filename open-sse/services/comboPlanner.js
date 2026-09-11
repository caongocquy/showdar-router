import { getCapabilitiesForModel } from "../providers/capabilities.js";

const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);

function splitModel(value) {
  const slash = typeof value === "string" ? value.indexOf("/") : -1;
  return slash > 0 ? [value.slice(0, slash), value.slice(slash + 1)] : ["", value];
}

export async function planComboCandidates({ models, requiredCapabilities = new Set(), inspectHealth = async () => ({ skip: false }), getCapabilities = getCapabilitiesForModel }) {
  const required = [...requiredCapabilities];
  const hard = required.filter((cap) => HARD_CAPS.has(cap));
  const planned = [];
  const skipped = [];

  for (const model of Array.isArray(models) ? models : []) {
    const [provider, name] = splitModel(model);
    const caps = getCapabilities(provider, name) || {};
    if (!hard.every((cap) => caps[cap] === true)) continue;
    let health;
    try { health = await inspectHealth(model); } catch { health = { skip: false }; }
    if (health?.skip) { skipped.push({ model, nextProbeAt: health.nextProbeAt || null }); continue; }
    planned.push(model);
  }

  return {
    models: planned,
    missingCapabilities: planned.length === 0 && skipped.length === 0 ? hard : [],
    skipped,
    routeUnavailable: planned.length === 0 && skipped.length > 0,
  };
}
