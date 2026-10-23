// Close the process-global SQLite adapter before deleting a test database.
// Vitest module resets alone leave its native file handles open on Windows.
export async function closeTestDbAdapter() {
  const state = globalThis._dbAdapter;
  try {
    if (state?.initPromise) await state.initPromise;
    state?.instance?.close?.();
  } finally {
    delete globalThis._dbAdapter;
  }
}
