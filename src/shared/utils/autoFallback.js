// Persist the automatic capacity-fallback opt-in.
//
// The toggle writes a safety control, so a lost or out-of-order PATCH must not
// leave the UI claiming OFF while the server still has it ON. Requests are
// serialized and each call reports the server's persisted value; a stale
// completion is flagged so the caller can ignore it.
export function createAutoFallbackWriter({ fetchImpl = (...args) => fetch(...args) } = {}) {
  let queue = Promise.resolve();
  let intent = 0;

  return function persistAutoFallback(value) {
    const requestId = ++intent;
    const isStale = () => requestId !== intent;

    const run = async () => {
      try {
        const res = await fetchImpl("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capacityAdapterAutoFallback: value }),
        });
        if (!res.ok) throw new Error(`Settings update failed (HTTP ${res.status})`);
        const data = await res.json().catch(() => ({}));
        return {
          ok: true,
          stale: isStale(),
          persisted: typeof data?.capacityAdapterAutoFallback === "boolean" ? data.capacityAdapterAutoFallback : value,
        };
      } catch (error) {
        // Never guess: re-read what the server actually stored.
        let persisted;
        try {
          const res = await fetchImpl("/api/settings");
          if (res.ok) {
            const data = await res.json();
            if (typeof data?.capacityAdapterAutoFallback === "boolean") persisted = data.capacityAdapterAutoFallback;
          }
        } catch {
          // Server truth unavailable; the caller falls back to its previous value.
        }
        return { ok: false, stale: isStale(), persisted, error };
      }
    };

    queue = queue.then(run);
    return queue;
  };
}
