import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const npmInvocationPath = path.join(repoRoot, "scripts", "lib", "npm-invocation.mjs");
const { npmInvocation } = await import(npmInvocationPath);

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Node >= 20 refuses to spawn a Windows .cmd/.bat shim without a shell, so a
// tool that runs `npm` directly must go through the npm JS entry on Windows.
// These assertions describe real spawn behaviour, not a mocked assumption.
describe("Windows-safe npm invocation", () => {
  it("uses the current Node with npm's JS entry on win32 (no .cmd shim)", () => {
    // Vendor a fake Node layout so the assertion is deterministic regardless of
    // whether this host's Node bundles npm (real Windows installers do).
    const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-node-layout-"));
    tempDirs.push(nodeDir);
    const npmCli = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    fs.mkdirSync(path.dirname(npmCli), { recursive: true });
    fs.writeFileSync(npmCli, "// stub\n");
    const execPath = path.join(nodeDir, "node.exe");

    const invocation = npmInvocation(["run", "build"], "win32", execPath);
    assert.equal(invocation.executable, execPath);
    assert.equal(invocation.args[0], npmCli);
    assert.deepEqual(invocation.args.slice(1), ["run", "build"]);
    assert.ok(!invocation.args.some((arg) => arg.endsWith(".cmd")), "must not pass an npm.cmd shim");
  });

  it("fails loudly when no npm JS entry sits next to the Node runtime", () => {
    const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-node-bare-"));
    tempDirs.push(nodeDir);
    assert.throws(
      () => npmInvocation(["run", "build"], "win32", path.join(nodeDir, "node.exe")),
      /npm CLI not found next to the Node runtime/,
    );
  });

  it("uses the plain npm binary off Windows", () => {
    for (const platform of ["linux", "darwin"]) {
      assert.deepEqual(npmInvocation(["--version"], platform), { executable: "npm", args: ["--version"] });
    }
  });

  it("actually spawns npm successfully on this platform", () => {
    const invocation = npmInvocation(["--version"]);
    const result = spawnSync(invocation.executable, invocation.args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  it("never hands a .cmd/.bat shim to execFileSync in release tooling", () => {
    const tooling = [
      "scripts/standalone-runtime-smoke.mjs",
      "scripts/package-release-bundle.mjs",
      "scripts/build-production.mjs",
      "scripts/npm-install-smoke.mjs",
      "scripts/verify-test-files.mjs",
      "scripts/release-bundle-smoke.mjs",
    ];
    for (const relative of tooling) {
      const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
      assert.doesNotMatch(
        source,
        /execFileSync\([^)]*\.cmd/,
        `${relative} must not execFileSync a .cmd shim (EINVAL on Windows/Node >= 20)`,
      );
    }
  });

  it("routes the standalone smoke's build through the shared helper", () => {
    const source = fs.readFileSync(path.join(repoRoot, "scripts/standalone-runtime-smoke.mjs"), "utf8");
    assert.match(source, /npmInvocation/, "standalone-runtime-smoke.mjs must use npmInvocation for `npm run build`");
    assert.doesNotMatch(source, /\? "npm\.cmd"/, "the direct npm.cmd spawn must not come back");
  });
});
