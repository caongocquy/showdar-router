const state = new Map();

export function resetComboRoundRobin(name) {
  if (name) state.delete(name); else state.clear();
}

export function scheduleComboModels(models, comboName, stickyLimit = 1) {
  if (!Array.isArray(models) || models.length < 2) return [...(models || [])];
  const key = comboName || "__default__";
  const limit = Math.max(1, Number.parseInt(stickyLimit, 10) || 1);
  const current = state.get(key) || { index: 0, uses: 0 };
  const index = current.index % models.length;
  const output = models.slice(index).concat(models.slice(0, index));
  const uses = current.uses + 1;
  state.set(key, uses >= limit ? { index: (index + 1) % models.length, uses: 0 } : { index, uses });
  return output;
}

export function resetComboScheduling(name) { resetComboRoundRobin(name); }
