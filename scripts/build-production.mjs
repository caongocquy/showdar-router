import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nextDir = resolve(root, process.env.NEXT_DIST_DIR || ".next");
rmSync(nextDir, { recursive: true, force: true });

// Invoke Next's JS entry via the current Node, not the node_modules/.bin shim:
// Node refuses to spawn a Windows .cmd/.bat without a shell (EINVAL since
// Node 20), so the shim path breaks every Windows build.
const next = resolve(root, "node_modules", "next", "dist", "bin", "next");
if (!existsSync(next)) throw new Error("Next.js is not installed. Run npm install first.");
execFileSync(process.execPath, [next, "build", "--webpack"], { cwd: root, stdio: "inherit" });
