// Fetch and cache suggested models for providers that expose a public models API
// Fetches via backend proxy to avoid CORS issues

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map(); // key: providerId → { data, expiresAt }

/**
 * Fetch suggested models for a provider through the trusted server registry.
 * Results are cached in-memory for CACHE_TTL_MS.
 * @param {string} providerId
 * @returns {Promise<Array<{ id: string, name: string, contextLength?: number }>>}
 */
export async function fetchSuggestedModels(providerId) {
  if (!providerId) return [];

  const cached = cache.get(providerId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const params = new URLSearchParams({ providerId });
    const res = await fetch(`/api/providers/suggested-models?${params}`);
    if (!res.ok) return [];
    const json = await res.json();
    const data = json.data ?? [];
    cache.set(providerId, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  } catch {
    return [];
  }
}
