import { it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepository } from "../../scripts/check-legacy-identifiers.mjs";

it("reports legacy identity in source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "showdar-legacy-"));
  await writeFile(join(root, "source.js"), "const name = '9router';\n");

  const result = await scanRepository(root);

  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].text, /9router/);
});

it("allows documented compatibility paths only", async () => {
  const root = await mkdtemp(join(tmpdir(), "showdar-legacy-"));
  await mkdir(join(root, "src", "lib", "db", "repos"), { recursive: true });
  await writeFile(join(root, "src", "lib", "db", "repos", "settingsRepo.js"), "return '.9router';\n");

  const result = await scanRepository(root);

  assert.equal(result.violations.length, 0);
  assert.equal(result.allowed.length, 1);
});

it("skips generated and binary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "showdar-legacy-"));
  await mkdir(join(root, ".next", "server"), { recursive: true });
  await writeFile(join(root, ".next", "server", "generated.js"), "9router\n");
  await writeFile(join(root, "image.png"), Buffer.from("9router"));

  const result = await scanRepository(root);

  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.allowed, []);
});

it("does not skip docs/superpowers", async () => {
  const root = await mkdtemp(join(tmpdir(), "showdar-legacy-"));
  await mkdir(join(root, "docs", "superpowers"), { recursive: true });
  await writeFile(join(root, "docs", "superpowers", "old-plan.md"), "9router\n");

  const result = await scanRepository(root);

  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].file, "docs/superpowers/old-plan.md");
});

it("allowlists only the GitBook deployment target occurrence", async () => {
  const root = await mkdtemp(join(tmpdir(), "showdar-legacy-"));
  await mkdir(join(root, "gitbook"), { recursive: true });
  await writeFile(join(root, "gitbook", "package.json"), [
    '{',
    '  "name": "9router-docs",',
    '  "version": "0.1.0",',
    '  "type": "module",',
    '  "scripts": {',
    '    "build": "next build",',
    '    "start": "next start",',
    '    "preview": "next start",',
    '    "deploy": "npx wrangler pages deploy out --project-name=9router-docs"',
    '  },',
    '  "description": "Showdar docs",',
    '  "legacy": "9router package",',
    '}',
  ].join("\n"));

  const result = await scanRepository(root);

  assert.equal(result.allowed.length, 1);
  assert.equal(result.allowed[0].line, 9);
  assert.equal(result.violations.length, 2);
  assert.equal(result.violations[0].line, 2);
  assert.equal(result.violations[1].line, 12);
});

it("README attribution allowlist requires the exact reviewed line", async () => {
  const root = await mkdtemp(join(tmpdir(), "showdar-legacy-"));
  const attribution = "Showdar Router originated as an independent fork of [decolua/9router](https://github.com/decolua/9router) and is now maintained as its own product.";

  await writeFile(join(root, "README.md"), `${attribution}\n`);
  let result = await scanRepository(root);
  assert.equal(result.violations.length, 0);
  assert.equal(result.allowed.length, 2);

  await writeFile(join(root, "README.md"), `${attribution} Download 9router here.\n`);
  result = await scanRepository(root);
  assert.equal(result.violations.length, 3);

  await writeFile(join(root, "README.md"), `${attribution}\nLegacy product: 9router.\n`);
  result = await scanRepository(root);
  assert.equal(result.violations.length, 1);
});
