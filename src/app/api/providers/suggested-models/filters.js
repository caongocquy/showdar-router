// Free OpenCode models that don't use the "-free" id suffix
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];

// Upstream returns "Model is unavailable" for this id (2026-09-02) — re-enable when fixed
const DEAD_FREE_OPENCODE_MODELS = new Set(["deepseek-v4-flash-free"]);

function contextLength(model) {
  const value = Number(model?.context_length ?? model?.contextLength);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function item(model) {
  if (typeof model?.id !== "string" || !model.id) return null;
  const result = { id: model.id, name: model.name || model.id };
  const context = contextLength(model);
  if (context !== undefined) result.contextLength = context;
  return result;
}

export const FILTERS = {
  "openrouter-free": (models) =>
    models
      .filter(
        (m) =>
          String(m.pricing?.prompt) === "0" &&
          String(m.pricing?.completion) === "0" &&
          contextLength(m) >= 200000
      )
      .map(item)
      .filter(Boolean)
      .sort((a, b) => b.contextLength - a.contextLength),

  "opencode-free": (models) =>
    models
      .filter((m) => (m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id)) && !DEAD_FREE_OPENCODE_MODELS.has(m.id))
      .map(item)
      .filter(Boolean),

  // models.dev returns a large catalog; keep only mimo models
  "mimo-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => m.id?.startsWith("mimo") || m.name?.toLowerCase().includes("mimo"))
      .map(item)
      .filter(Boolean),
};
