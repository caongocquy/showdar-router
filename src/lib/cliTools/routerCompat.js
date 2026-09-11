export const SHOWDAR_ROUTER_ID = "showdar-router";
export const LEGACY_ROUTER_ID = "9router";

const MODEL_PREFIXES = [`${SHOWDAR_ROUTER_ID}/`, `${LEGACY_ROUTER_ID}/`];

export function getRouterEntry(entries) {
  return entries?.[SHOWDAR_ROUTER_ID] ?? entries?.[LEGACY_ROUTER_ID] ?? null;
}

export function getOpenCodeProvider(config) {
  return getRouterEntry(config?.provider);
}

export function getOpenClawProvider(settings) {
  return getRouterEntry(settings?.models?.providers);
}

export function getJcodeProvider(config) {
  return getRouterEntry(config?.providers);
}

export function normalizeRouterEntries(entries = {}, canonicalEntry) {
  const next = { ...entries, [SHOWDAR_ROUTER_ID]: canonicalEntry };
  delete next[LEGACY_ROUTER_ID];
  return next;
}

export function removeRouterEntries(entries = {}) {
  const next = { ...entries };
  delete next[SHOWDAR_ROUTER_ID];
  delete next[LEGACY_ROUTER_ID];
  return next;
}

export function isRouterModel(model) {
  return typeof model === "string" && MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

export function stripRouterModel(model) {
  if (!isRouterModel(model)) return null;
  return model.slice(model.indexOf("/") + 1);
}
