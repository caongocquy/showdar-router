import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let testApi;
try {
  testApi = await import("vitest");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  testApi = await import("node:test");
}
const { afterEach, describe, it } = testApi;

const require = createRequire(import.meta.url);
const { assertGeneratedSrcParity } = require("../../cli/scripts/build-cli.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempDirs = [];

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-router-cli-parity-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeFixture(root, relativePath, contents = relativePath) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

// Minimal parity-clean tree: canonical app source plus the generated cli app
// (required runtime files, one byte-identical traced duplicate, MITM bundle).
function createParityTree() {
  const root = createTempDir();
  const appDir = path.join(root, "app");
  const cliAppDir = path.join(root, "cli-app");

  writeFixture(appDir, "src/sse/services/backgroundTokenRefresh.js", "canonical token refresh");
  writeFixture(appDir, "src/lib/updater/updater.js", "canonical updater");
  writeFixture(appDir, "src/mitm/server.js", "canonical plain mitm source");
  writeFixture(appDir, "src/lib/db/driver.js", "canonical driver");
  writeFixture(appDir, "server.js", "canonical server");
  writeFixture(appDir, "custom-server.js", "canonical custom server");

  writeFixture(cliAppDir, "server.js", "canonical server");
  writeFixture(cliAppDir, "custom-server.js", "canonical custom server");
  writeFixture(cliAppDir, "src/sse/services/backgroundTokenRefresh.js", "canonical token refresh");
  writeFixture(cliAppDir, "src/lib/updater/updater.js", "canonical updater");
  writeFixture(cliAppDir, "src/lib/db/driver.js", "canonical driver");
  writeFixture(cliAppDir, "src/mitm/server.js", "var b=1;/* esbuild bundle of canonical plain mitm source */");

  return { root, appDir, cliAppDir };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("CLI generated source parity", () => {
  it("passes for a parity-clean generated tree", () => {
    const { appDir, cliAppDir } = createParityTree();
    assert.doesNotThrow(() => assertGeneratedSrcParity(cliAppDir, appDir));
  });

  it("fails when a generated duplicate drifts from canonical src", () => {
    const { appDir, cliAppDir } = createParityTree();
    writeFixture(cliAppDir, "src/lib/db/driver.js", "hand-edited driver");

    assert.throws(
      () => assertGeneratedSrcParity(cliAppDir, appDir),
      (error) => error.message.includes("drifts from canonical source: src/lib/db/driver.js"),
    );
  });

  it("fails when a required runtime file is missing", () => {
    const { appDir, cliAppDir } = createParityTree();
    fs.rmSync(path.join(cliAppDir, "src/lib/updater/updater.js"));

    assert.throws(
      () => assertGeneratedSrcParity(cliAppDir, appDir),
      (error) => error.message.includes("missing required packaged file: src/lib/updater/updater.js"),
    );
  });

  it("fails when the plain MITM source ships instead of the esbuild bundle", () => {
    const { appDir, cliAppDir } = createParityTree();
    writeFixture(cliAppDir, "src/mitm/server.js", "canonical plain mitm source");

    assert.throws(
      () => assertGeneratedSrcParity(cliAppDir, appDir),
      (error) => error.message.includes("plain source copy, not the esbuild bundle"),
    );
  });

  it("fails when plain MITM sibling files ship alongside the bundle", () => {
    const { appDir, cliAppDir } = createParityTree();
    writeFixture(cliAppDir, "src/mitm/logger.js", "plain sibling");

    assert.throws(
      () => assertGeneratedSrcParity(cliAppDir, appDir),
      (error) => error.message.includes("must contain only the built server.js bundle"),
    );
  });

  it("fails when a generated file has no canonical source", () => {
    const { appDir, cliAppDir } = createParityTree();
    writeFixture(cliAppDir, "src/lib/orphan.js", "stale leftover");

    assert.throws(
      () => assertGeneratedSrcParity(cliAppDir, appDir),
      (error) => error.message.includes("generated file has no canonical source: src/lib/orphan.js"),
    );
  });

  it("ships a parity-clean built tree in this checkout when cli/app exists", () => {
    const cliAppDir = path.join(repoRoot, "cli", "app");
    if (!fs.existsSync(path.join(cliAppDir, "src"))) {
      // cli/app is gitignored build output; verified for real by build-cli.js step 9
      // and by CI's "Build and validate npm package" stage.
      return;
    }
    assert.doesNotThrow(() => assertGeneratedSrcParity(cliAppDir, repoRoot));
  });
});
