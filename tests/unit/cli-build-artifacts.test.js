import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

let testApi;
try {
  testApi = await import("vitest");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  testApi = await import("node:test");
}
const { afterEach, describe, it } = testApi;

const require = createRequire(import.meta.url);
const {
  assertRequiredApiArtifacts,
  copyStandaloneBuild,
  mergeServerArtifacts,
  normalizeGeneratedJson,
  normalizeGeneratedText,
} = require("../../cli/scripts/build-cli.js");

const tempDirs = [];

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-router-cli-build-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeFixture(root, relativePath, contents = relativePath) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function listFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function createCompleteServer(buildDistDir) {
  const serverDir = path.join(buildDistDir, "server");
  writeFixture(serverDir, "app/api/v1/chat/completions/route.js", "chat route");
  writeFixture(serverDir, "app/api/v1/messages/route.js", "messages route");
  writeFixture(serverDir, "chunks/openai-provider.js", "openai chunk");
  writeFixture(serverDir, "chunks/anthropic-provider.js", "anthropic chunk");
  return serverDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("CLI build server artifacts", () => {
  it("normalizes only exact build-root path boundaries and is idempotent", () => {
    const root = "/repo/foo";
    const source = [
      `const a = "${root}";`,
      `const b = "${root}/server/file.js";`,
      `const c = "/repo/foobar/server/file.js";`,
      `const d = "/repo/foo-other/file.js";`,
      `const e = "/repo/foo2/file.js";`,
      `const f = "prefix${root}/file.js";`,
      `const g = "${root}/one"; const g2 = "${root}/two";`,
      `const h = fileURLToPath("file://${root}/src/entry.js");`,
      `const i = "prefix ${root} text";`,
      `const j = "xfile://${root}/server.js";`,
    ].join("\n");
    const normalized = normalizeGeneratedText(source, root);

    assert.match(normalized, /const a = "\."/);
    assert.match(normalized, /const b = "\.\/server\/file\.js"/);
    assert.match(normalized, /const c = "\/repo\/foobar\/server\/file\.js"/);
    assert.match(normalized, /const d = "\/repo\/foo-other\/file\.js"/);
    assert.match(normalized, /const e = "\/repo\/foo2\/file\.js"/);
    assert.match(normalized, /const f = "prefix\/repo\/foo\/file\.js"/);
    assert.match(normalized, /const g = "\.\/one"; const g2 = "\.\/two"/);
    assert.match(normalized, /fileURLToPath\("file:\/\/" \+ process\.cwd\(\) \+ "\/src\/entry\.js"\)/);
    assert.match(normalized, /const i = "prefix \/repo\/foo text"/);
    assert.match(normalized, /const j = "xfile:\/\/\/repo\/foo\/server\.js"/);
    assert.equal(normalizeGeneratedText(normalized, root), normalized);
    assert.doesNotThrow(() => new vm.Script(normalized));
  });

  it("normalizes the observed escaped JSON path representation without changing keys", () => {
    const root = "/repo/foo";
    const input = '{"key":"\\/repo\\/foo\\/value","path":"/repo/foo/server.js"}';
    const escapedNormalized = normalizeGeneratedText(input, root);
    const normalized = normalizeGeneratedJson(escapedNormalized, root);
    const parsed = JSON.parse(normalized);

    assert.equal(parsed.key, "./value");
    assert.equal(parsed.path, "./server.js");
    const structured = JSON.parse(normalizeGeneratedJson(
      JSON.stringify({ "/repo/foo/key": "/repo/foo/value" }),
      root,
    ));
    assert.equal(structured["./key"], "./value");
    assert.equal(normalizeGeneratedJson(normalized, root), normalized);
  });

  for (const { name, standalonePath } of [
    {
      name: "legacy nested app",
      standalonePath: (appDir, buildDistDir) => path.join(appDir, ".next", "standalone", "app"),
    },
    {
      name: "Next 16 workspace",
      standalonePath: (appDir, buildDistDir) => path.join(buildDistDir, "standalone", path.basename(appDir)),
    },
  ]) {
    it(`merges complete API routes and provider chunks for the ${name} layout`, () => {
      const root = createTempDir();
      const appDir = path.join(root, "showdar-router");
      const buildDistDir = path.join(appDir, ".next-cli-build");
      const cliAppDir = path.join(root, "cli-app");
      const standaloneDir = standalonePath(appDir, buildDistDir);

      writeFixture(standaloneDir, "server.js", "standalone server");
      writeFixture(
        standaloneDir,
        ".next-cli-build/server/app/api/v1/chat/completions/route.js",
        "standalone chat route",
      );
      createCompleteServer(buildDistDir);

      copyStandaloneBuild(appDir, buildDistDir, cliAppDir);
      mergeServerArtifacts(buildDistDir, cliAppDir);
      assertRequiredApiArtifacts(cliAppDir);

      const packagedServer = path.join(cliAppDir, ".next-cli-build", "server");
      assert.equal(
        fs.readFileSync(path.join(packagedServer, "app/api/v1/messages/route.js"), "utf8"),
        "messages route",
      );
      assert.equal(
        fs.readFileSync(path.join(packagedServer, "chunks/openai-provider.js"), "utf8"),
        "openai chunk",
      );
      assert.equal(
        fs.readFileSync(path.join(packagedServer, "chunks/anthropic-provider.js"), "utf8"),
        "anthropic chunk",
      );
    });
  }

  it("merges idempotently without removing standalone-generated files", () => {
    const root = createTempDir();
    const buildDistDir = path.join(root, ".next-cli-build");
    const cliAppDir = path.join(root, "cli-app");
    const packagedServer = path.join(cliAppDir, ".next-cli-build", "server");

    createCompleteServer(buildDistDir);
    writeFixture(packagedServer, "standalone-only.js", "keep me");

    mergeServerArtifacts(buildDistDir, cliAppDir);
    mergeServerArtifacts(buildDistDir, cliAppDir);

    assert.equal(
      fs.readFileSync(path.join(packagedServer, "standalone-only.js"), "utf8"),
      "keep me",
    );
    assert.equal(
      fs.readFileSync(path.join(packagedServer, "app/api/v1/messages/route.js"), "utf8"),
      "messages route",
    );
  });

  it("reports the missing required API route artifact path", () => {
    const root = createTempDir();
    const buildDistDir = path.join(root, ".next-cli-build");
    const cliAppDir = path.join(root, "cli-app");

    writeFixture(
      path.join(buildDistDir, "server"),
      "app/api/v1/chat/completions/route.js",
      "chat route",
    );
    mergeServerArtifacts(buildDistDir, cliAppDir);

    assert.throws(
      () => assertRequiredApiArtifacts(cliAppDir),
      (error) => error.message.includes(path.join(
        cliAppDir,
        ".next-cli-build/server/app/api/v1/messages/route.js",
      )),
    );
  });

  it("publishes required distribution output without machine-local artifacts or paths", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const packageDir = createTempDir();
    const pack = JSON.parse(execFileSync("npm", [
      "pack", "--json", "--ignore-scripts", "--pack-destination", packageDir,
    ], {
      cwd: path.join(repoRoot, "cli"),
      env: { ...process.env, npm_config_cache: createTempDir() },
      encoding: "utf8",
    }))[0];

    assert.ok(pack.files.some(({ path: file }) => file.startsWith("app/.next-cli-build/")));
    const forbiddenFiles = pack.files
      .map(({ path: file }) => file)
      .filter((file) => /(^|\/)(?:\.next(?:\/|$)|\.showdar-router-backup|Users\/|\.build-home)/.test(file)
        || file === ["images", "9" + "router.png"].join("/"));
    assert.deepEqual(forbiddenFiles, []);

    const archive = path.join(packageDir, pack.filename);
    const extracted = createTempDir();
    execFileSync("tar", ["-xzf", archive, "-C", extracted]);
    const packagedRoot = path.join(extracted, "package");
    const generatedRoot = path.join(packagedRoot, "app");
    const machinePaths = [repoRoot, os.homedir()].filter(Boolean);
    const leakedFiles = [];
    for (const file of listFiles(generatedRoot)) {
      const contents = fs.readFileSync(file);
      if (machinePaths.some((machinePath) => contents.includes(Buffer.from(machinePath)))) {
        leakedFiles.push(path.relative(packagedRoot, file));
      }
    }
    assert.deepEqual(leakedFiles, []);
  }, 30_000);
});
