import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nextDir = resolve(root, process.env.NEXT_DIST_DIR || ".next");
rmSync(nextDir, { recursive: true, force: true });

const next = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
if (!existsSync(next)) throw new Error("Next.js is not installed. Run npm install first.");
execFileSync(next, ["build", "--webpack"], { cwd: root, stdio: "inherit" });
