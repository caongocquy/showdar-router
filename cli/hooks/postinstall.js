#!/usr/bin/env node

// Postinstall: warm-up SQLite deps into ~/.showdar-router/runtime so the first
// Showdar Router start doesn't need network. Failure here is non-fatal —
// cli.js will retry at runtime if anything is missing.
const { ensureSqliteRuntime } = require("./sqliteRuntime");
const { ensureTrayRuntime } = require("./trayRuntime");

const PERMISSION_HINT = "[Showdar Router] If this is a permission error, set DATA_DIR to a user-writable path; do not use sudo.";

function runWarmup({
  sqlite = ensureSqliteRuntime,
  tray = ensureTrayRuntime,
  log = console.log,
  warn = console.warn,
} = {}) {
  try {
    sqlite({ silent: false });
    log("[Showdar Router] runtime SQLite deps ready");
  } catch (e) {
    warn(`[Showdar Router] runtime warm-up skipped: ${e.message}`);
    warn(PERMISSION_HINT);
  }

  try {
    tray({ silent: false });
  } catch (e) {
    warn(`[Showdar Router] tray runtime skipped: ${e.message}`);
    warn(PERMISSION_HINT);
  }
}

if (require.main === module) {
  runWarmup();
  process.exit(0);
}

module.exports = { runWarmup };
