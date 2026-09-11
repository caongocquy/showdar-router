// Fetch suggested models for providers that expose a public models API
// Fetches via backend proxy to avoid CORS issues

/**
 * Fetch suggested models for a provider through the trusted server registry.
 * @param {string} providerId
 * @returns {Promise<Array<{ id: string, name: string, contextLength?: number }>>}
 */
export async function fetchSuggestedModels(providerId) {
  if (!providerId) return [];

  try {
    const params = new URLSearchParams({ providerId });
    const res = await fetch(`/api/providers/suggested-models?${params}`);
    if (!res.ok) return [];
    const json = await res.json();
    return json.data ?? [];
  } catch {
    return [];
  }
}
