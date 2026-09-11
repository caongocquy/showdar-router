const state = new Map();
const legacyState = new Map();
const locks = new Map();

export function resetComboRoundRobin(name) {
  if (name) { state.delete(name); legacyState.delete(name); }
  else { state.clear(); legacyState.clear(); }
}

export async function withComboSchedulingLock(name, fn) {
  const key = name || "__default__";
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(key, current);
  await previous;
  try { return await fn(); } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

export function scheduleComboModels(models, comboName, stickyLimit = 1) {
  if (!Array.isArray(models) || models.length < 2) return [...(models || [])];
  const key = comboName || "__default__";
  const limit = Math.max(1, Number.parseInt(stickyLimit, 10) || 1);
  const current = legacyState.get(key) || { index: 0, uses: 0 };
  const index = current.index % models.length;
  const output = models.slice(index).concat(models.slice(0, index));
  const uses = current.uses + 1;
  legacyState.set(key, uses >= limit ? { index: (index + 1) % models.length, uses: 0 } : { index, uses });
  return output;
}

export function selectComboModels(eligible, configured, comboName) {
  if (!Array.isArray(eligible) || eligible.length < 2) return [...(eligible || [])];
  const configuredModels = Array.isArray(configured) && configured.length ? configured : eligible;
  const next = state.get(comboName || "__default__")?.nextModel;
  const start = next ? Math.max(0, configuredModels.indexOf(next)) : 0;
  const primary = eligible.find((model) => configuredModels.indexOf(model) >= start) || eligible[0];
  const index = eligible.indexOf(primary);
  return eligible.slice(index).concat(eligible.slice(0, index));
}

export function commitComboPrimary(model, configured, comboName, stickyLimit = 1) {
  if (!Array.isArray(configured) || configured.length < 2) return;
  const key = comboName || "__default__";
  const limit = Math.max(1, Number.parseInt(stickyLimit, 10) || 1);
  const current = state.get(key) || { nextModel: configured[0], uses: 0 };
  const uses = current.nextModel === model ? current.uses + 1 : 1;
  const index = configured.indexOf(model);
  state.set(key, uses >= limit
    ? { nextModel: configured[(index + 1) % configured.length], uses: 0 }
    : { nextModel: model, uses });
}

export function resetComboScheduling(name) { resetComboRoundRobin(name); }
