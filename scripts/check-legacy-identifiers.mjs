import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extname, join, relative, resolve } from "node:path";

const execFileAsync = promisify(execFile);

const LEGACY_PATTERN = /\.9router|nine[-_ ]router|9router/gi;

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".next-cli-build",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

const BINARY_EXTENSIONS = new Set([
  ".ico", ".jpeg", ".jpg", ".png", ".webp", ".gif", ".woff", ".woff2", ".ttf", ".zip",
]);

const ALLOWLIST = [
  { path: "scripts/check-legacy-identifiers.mjs", reason: "scanner pattern definitions" },
  { path: "tests/unit/legacy-identifiers.test.js", reason: "scanner regression fixtures" },
  { path: "src/lib/db/repos/settingsRepo.js", reason: "SAML issuer compatibility identifier" },
  { path: "tests/unit/headroom-chat-core.test.js", reason: "legacy protocol header regression fixture" },
  { path: "tests/unit/kimi-usage.test.js", reason: "upstream provider platform header contract" },
  { path: "tests/unit/db-driver-chain.test.js", reason: "legacy temporary-directory fixture name" },
  { path: "tests/translator/real/", reason: "optional legacy data-directory fallback for real surveys" },
  { path: "open-sse/config/appConstants.js", reason: "upstream protocol platform header" },
  { path: "open-sse/config/runtimeConfig.js", reason: "legacy protocol token-saver header" },
  { path: "open-sse/executors/zed.js", reason: "upstream Zed client user-agent contract" },
  { path: "open-sse/shared/clineAuth.js", reason: "upstream Cline client header contract" },
  { path: "tests/translator/__snapshots__/golden-url-header.test.js.snap", reason: "upstream client header snapshots" },
  { path: "tests/auth/saml.test.js", reason: "SAML issuer compatibility fixture" },
  { path: "tests/unit/saml.test.js", reason: "SAML issuer compatibility fixture" },
  { path: "tests/unit/cursor-agent-proto.test.js", reason: "upstream cursor protocol fixture" },
  { path: "tests/unit/launcher-tray.test.mjs", reason: "legacy-name absence assertion" },
  { path: "tests/unit/security-audit.test.js", reason: "legacy environment cleanup fixture" },
  { path: "tests/unit/xai-video-handler.test.js", reason: "legacy response header contract" },
  { path: "tests/unit/cli-xai-video.test.js", reason: "legacy response header fixture" },
  { path: "tests/unit/minimax-transport-target-format.test.js", reason: "historical upstream regression reference" },
  { path: "cli/src/cli/commands/xaiVideo.js", reason: "legacy API key environment fallback" },
  { path: "src/lib/network/outboundProxy.js", reason: "legacy proxy environment cleanup compatibility" },
  { path: "src/app/api/cli-tools/jcode-settings/route.js", reason: "legacy jcode environment cleanup compatibility" },
  { path: "src/app/(dashboard)/dashboard/cli-tools/components/JcodeToolCard.js", reason: "legacy jcode environment cleanup compatibility" },
  { path: "src/lib/cliTools/routerCompat.js", reason: "shared legacy config migration compatibility" },
  { path: "src/lib/cliTools/jcodeCompat.js", reason: "legacy jcode environment cleanup compatibility" },
  { path: "tests/unit/router-compat.test.js", reason: "shared compatibility regression fixtures" },
  { path: "gitbook/package.json", line: 9, text: "9router", reason: "external Cloudflare Pages deployment target" },
  {
    path: "README.md",
    exactLine: "Showdar Router originated as an independent fork of [decolua/9router](https://github.com/decolua/9router) and is now maintained as its own product.",
    reason: "explicit upstream fork attribution",
  },
  { path: "tests/package.json", reason: "existing private test package identity preserved" },
  { path: "docs/superpowers/plans/2026-08-02-gpt-5-6-codex-reasoning-overrides.md", reason: "historical implementation plan" },
  { path: "docs/superpowers/plans/2026-09-04-opencode-go-session-header.md", reason: "historical implementation plan" },
  { path: "docs/superpowers/specs/2026-08-02-gpt-5-6-codex-reasoning-overrides-design.md", reason: "historical design specification" },
  { path: "docs/superpowers/specs/2026-09-04-opencode-go-session-header-design.md", reason: "historical design specification" },
];

function allowlistEntry(item) {
  return ALLOWLIST.find((entry) => {
    if (!(item.file === entry.path || item.file.startsWith(entry.path))) return false;
    if (entry.line !== undefined && item.line !== entry.line) return false;
    if (entry.text !== undefined && item.text !== entry.text) return false;
    if (entry.exactLine !== undefined && item.lineText !== entry.exactLine) return false;
    return true;
  });
}

async function collectFiles(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(path, files);
    else files.push(path);
  }
  return files;
}

async function repositoryFiles(base) {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C", base, "ls-files", "-z", "--cached", "--others", "--exclude-standard",
    ]);
    return stdout.split("\0").filter(Boolean).map((file) => join(base, file));
  } catch {
    return collectFiles(base);
  }
}

export async function scanRepository(root) {
  const base = resolve(root);
  const matches = [];
  const allowed = [];
  const violations = [];

  for (const file of await repositoryFiles(base)) {
    const relativePath = relative(base, file);
    if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const buffer = await readFile(file);
    if (buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    LEGACY_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(LEGACY_PATTERN)) {
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      const lineEnd = text.indexOf("\n", match.index);
      const line = text.slice(0, match.index).split("\n").length;
      const lineText = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
      const item = { file: relativePath, line, lineText, text: match[0] };
      matches.push(item);
      const entry = allowlistEntry(item);
      if (entry) allowed.push({ ...item, reason: entry.reason });
      else violations.push(item);
    }
  }

  return { matches, allowed, violations };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const result = await scanRepository(process.cwd());
  console.log(JSON.stringify({
    matches: result.matches.length,
    allowed: result.allowed.length,
    violations: result.violations.length,
  }, null, 2));
  for (const item of result.violations) console.error(`${item.file}:${item.line}: ${item.text}`);
  process.exitCode = result.violations.length ? 1 : 0;
}
