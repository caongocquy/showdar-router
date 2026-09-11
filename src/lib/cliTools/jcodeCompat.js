import fs from "fs/promises";
import path from "path";
import os from "os";

export const getLegacyProviderEnvPath = () => {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configDir, "jcode", "provider-9router.env");
};

export const removeLegacyProviderEnv = () =>
  fs.rm(getLegacyProviderEnvPath(), { force: true });
