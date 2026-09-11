import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  getJcodeProvider,
  getOpenClawProvider,
  getOpenCodeProvider,
  getRouterEntry,
  isRouterModel,
  normalizeRouterEntries,
  removeRouterEntries,
  stripRouterModel,
} from "../../src/lib/cliTools/routerCompat.js";
import { removeLegacyProviderEnv } from "../../src/lib/cliTools/jcodeCompat.js";

describe("router compatibility", () => {
  it.each([
    ["OpenCode", getOpenCodeProvider, { provider: { "showdar-router": { options: { baseURL: "new" } }, other: {} } }, { options: { baseURL: "new" } }],
    ["OpenCode", getOpenCodeProvider, { provider: { "9router": { options: { baseURL: "old" } }, other: {} } }, { options: { baseURL: "old" } }],
    ["OpenCode", getOpenCodeProvider, { provider: { "showdar-router": { options: { baseURL: "new" } }, "9router": { options: { baseURL: "old" } }, other: {} } }, { options: { baseURL: "new" } }],
    ["OpenClaw", getOpenClawProvider, { models: { providers: { "showdar-router": { baseUrl: "new" }, other: {} } } }, { baseUrl: "new" }],
    ["OpenClaw", getOpenClawProvider, { models: { providers: { "9router": { baseUrl: "old" }, other: {} } } }, { baseUrl: "old" }],
    ["OpenClaw", getOpenClawProvider, { models: { providers: { "showdar-router": { baseUrl: "new" }, "9router": { baseUrl: "old" }, other: {} } } }, { baseUrl: "new" }],
    ["Jcode", getJcodeProvider, { providers: { "showdar-router": { base_url: "new" }, other: {} } }, { base_url: "new" }],
    ["Jcode", getJcodeProvider, { providers: { "9router": { base_url: "old" }, other: {} } }, { base_url: "old" }],
    ["Jcode", getJcodeProvider, { providers: { "showdar-router": { base_url: "new" }, "9router": { base_url: "old" }, other: {} } }, { base_url: "new" }],
  ])("projects %s config using canonical-first fallback", (_name, project, config, expected) => {
    expect(project(config)).toEqual(expected);
  });

  it("reads the new entry before a legacy entry", () => {
    const canonical = { baseUrl: "new" };
    expect(getRouterEntry({ "9router": { baseUrl: "old" }, "showdar-router": canonical })).toBe(canonical);
    expect(getRouterEntry({ "9router": { baseUrl: "old" } })).toEqual({ baseUrl: "old" });
  });

  it("normalizes entries while preserving unrelated configuration", () => {
    const unrelated = { theme: "dark" };
    const result = normalizeRouterEntries(
      { "9router": { baseUrl: "old" }, other: unrelated },
      { baseUrl: "new" },
    );

    expect(result).toEqual({ "showdar-router": { baseUrl: "new" }, other: unrelated });
  });

  it("removes both identities but preserves unrelated configuration", () => {
    expect(removeRouterEntries({ "9router": {}, "showdar-router": {}, other: 1 })).toEqual({ other: 1 });
  });

  it("recognizes and strips both model prefixes", () => {
    expect(isRouterModel("showdar-router/model")).toBe(true);
    expect(isRouterModel("9router/model")).toBe(true);
    expect(stripRouterModel("showdar-router/model")).toBe("model");
    expect(stripRouterModel("9router/model")).toBe("model");
    expect(stripRouterModel("other/model")).toBe(null);
  });

  it("is idempotent when normalizing an already canonical entry", () => {
    const config = { "showdar-router": { baseUrl: "new" }, other: 1 };
    expect(normalizeRouterEntries(config, config["showdar-router"])).toEqual(config);
  });

  it("removes the legacy Jcode env file idempotently", async () => {
    const originalConfigHome = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "jcode-compat-"));
    const legacyDir = path.join(configHome, "jcode");
    const legacyPath = path.join(legacyDir, "provider-9router.env");
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(legacyPath, "JCODE_9ROUTER_API_KEY=secret\n");
      await removeLegacyProviderEnv();
      await removeLegacyProviderEnv();
      await expect(fs.access(legacyPath)).rejects.toThrow();
    } finally {
      if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalConfigHome;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });
});
