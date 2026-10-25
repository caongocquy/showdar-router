// Platform-safe npm invocation.
//
// Node >= 20 refuses to spawn a Windows .cmd/.bat shim without a shell
// (spawnSync/execFileSync throws EINVAL), so `npm` / `npm.cmd` cannot be
// executed directly on Windows. When a shell is not desired we run npm's JS
// entry with the current Node instead; elsewhere the plain `npm` binary is
// used. No shell, so no command interpolation.
import fs from "node:fs";
import path from "node:path";

export function npmInvocation(args, platform = process.platform, execPath = process.execPath) {
  if (platform !== "win32") return { executable: "npm", args };

  const npmCli = path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!fs.existsSync(npmCli)) {
    throw new Error(`npm CLI not found next to the Node runtime: ${npmCli}`);
  }
  return { executable: execPath, args: [npmCli, ...args] };
}
