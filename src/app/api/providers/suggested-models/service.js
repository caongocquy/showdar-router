import REGISTRY from "open-sse/providers/registry/index.js";
import { FILTERS } from "./filters.js";

const CACHE_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 10 * 1000;

function discoveryError(message, status) {
  return Object.assign(new Error(message), { status });
}

function trustedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function createModelDiscovery({
  registry = REGISTRY,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cacheTtlMs = CACHE_TTL_MS,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();

  const cleanExpired = (timestamp) => {
    for (const [key, value] of cache) {
      if (value.expiresAt <= timestamp) cache.delete(key);
    }
  };

  async function fetchProvider(provider) {
    const config = provider.modelsFetcher;
    const url = trustedUrl(config.url);
    const filter = FILTERS[config.type];
    if (!url) throw discoveryError("Invalid provider model discovery configuration", 500);
    if (!filter) throw discoveryError("Unsupported provider model discovery", 400);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) return { data: [], cacheable: false };
      const payload = await response.json();
      const raw = payload?.data ?? payload?.models ?? payload;
      return { data: filter(Array.isArray(raw) ? raw : []), cacheable: true };
    } catch {
      return { data: [], cacheable: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function discover(providerId) {
    if (!providerId) throw discoveryError("Missing providerId", 400);
    const provider = registry.find((entry) => entry.id === providerId);
    if (!provider) throw discoveryError("Unknown provider", 404);
    if (!provider.modelsFetcher) throw discoveryError("Provider has no model discovery", 400);

    const timestamp = now();
    cleanExpired(timestamp);
    const cached = cache.get(providerId);
    if (cached) return cached.data;
    if (inFlight.has(providerId)) return inFlight.get(providerId);

    const request = fetchProvider(provider)
      .then(({ data, cacheable }) => {
        if (cacheable) cache.set(providerId, { data, expiresAt: now() + cacheTtlMs });
        return data;
      })
      .finally(() => inFlight.delete(providerId));
    inFlight.set(providerId, request);
    return request;
  }

  return { discover, clear: () => { cache.clear(); inFlight.clear(); } };
}

export const modelDiscovery = createModelDiscovery();
