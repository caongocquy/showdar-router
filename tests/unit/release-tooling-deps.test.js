import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let testApi;
try {
  testApi = await import("vitest");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  testApi = await import("node:test");
}
const { describe, it } = testApi;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "release-artifacts.yml");

// The manual-backfill path copies a declared set of tooling files from the
// default branch before it builds/smokes a historical tag. If a script in that
// set imports a sibling that is NOT in the set, backfill breaks at run time
// (the historical tag has no such file). This guards the whole closure.
function declaredTooling() {
  const source = fs.readFileSync(workflowPath, "utf8");
  const lists = [...source.matchAll(/^\s*TOOLING:\s*(.+)$/gm)].map((m) => m[1].trim().split(/\s+/));
  assert.ok(lists.length > 0, "release-artifacts.yml must declare a TOOLING list");
  const union = new Set(lists.flat());
  // Every declaration must be a subset of the union used by the build job, so
  // the publish job cannot silently forget a file the build job refreshes.
  for (const list of lists) {
    for (const file of list) assert.ok(union.has(file), `${file} must be in the union of declared tooling`);
  }
  return union;
}

function relativeImports(source) {
  const found = new Set();
  for (const match of source.matchAll(/(?:from\s+|require\()\s*["'](\.[^"']+)["']/g)) {
    found.add(match[1]);
  }
  return found;
}

describe("release backfill tooling closure", () => {
  it("every declared tooling file exists in the repository", () => {
    for (const file of declaredTooling()) {
      assert.ok(fs.existsSync(path.join(repoRoot, file)), `declared tooling missing from repo: ${file}`);
    }
  });

  it("the declared set is closed under relative imports (transitive closure)", () => {
    const tooling = declaredTooling();
    for (const file of tooling) {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      for (const specifier of relativeImports(source)) {
        const resolved = path.relative(repoRoot, path.resolve(path.dirname(path.join(repoRoot, file)), specifier)).split(path.sep).join("/");
        assert.ok(
          tooling.has(resolved),
          `${file} imports ${resolved}, which the backfill TOOLING list does not restore`,
        );
      }
    }
  });

  it("the build job's list includes package-release-bundle.mjs and its npm helper", () => {
    const tooling = declaredTooling();
    assert.ok(tooling.has("scripts/package-release-bundle.mjs"));
    assert.ok(tooling.has("scripts/lib/npm-invocation.mjs"));
    assert.ok(tooling.has("scripts/release-bundle-smoke.mjs"));
    assert.ok(tooling.has("scripts/verify-release-assets.mjs"));
  });
});
