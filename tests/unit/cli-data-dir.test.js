import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CLIENT_PATH = require.resolve("../../cli/src/cli/api/client.js");
const ENV_KEYS = ["SHOWDAR_ROUTER_DATA_DIR", "DATA_DIR"];
const CLI_TOKEN_SALT = "9r-cli-auth";

const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showdar-cli-data-dir-"));
  tempDirs.push(dir);
  return dir;
}

// Paths are resolved at module init, so each case needs a fresh module.
function loadClient() {
  delete require.cache[CLIENT_PATH];
  return require(CLIENT_PATH);
}

function expectedToken(raw, secret) {
  return crypto.createHash("sha256").update(raw + CLI_TOKEN_SALT + secret).digest("hex").substring(0, 16);
}

function writeMachineId(dir, raw) {
  fs.writeFileSync(path.join(dir, "machine-id"), raw);
}

function writeCliSecret(dir, secret) {
  fs.mkdirSync(path.join(dir, "auth"), { recursive: true });
  fs.writeFileSync(path.join(dir, "auth", "cli-secret"), secret);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("CLI API client data dir precedence", () => {
  it("prefers SHOWDAR_ROUTER_DATA_DIR when both are set", () => {
    const primary = tempDir();
    const legacy = tempDir();
    process.env.SHOWDAR_ROUTER_DATA_DIR = primary;
    process.env.DATA_DIR = legacy;

    expect(loadClient().getDataDir()).toBe(primary);
  });

  it("honours SHOWDAR_ROUTER_DATA_DIR alone", () => {
    const dir = tempDir();
    process.env.SHOWDAR_ROUTER_DATA_DIR = dir;
    delete process.env.DATA_DIR;

    expect(loadClient().getDataDir()).toBe(dir);
  });

  it("still honours DATA_DIR alone for existing installations", () => {
    const dir = tempDir();
    process.env.DATA_DIR = dir;
    delete process.env.SHOWDAR_ROUTER_DATA_DIR;

    expect(loadClient().getDataDir()).toBe(dir);
  });

  it("falls back to the platform default when neither is set", () => {
    delete process.env.DATA_DIR;
    delete process.env.SHOWDAR_ROUTER_DATA_DIR;

    const expected =
      process.platform === "win32"
        ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "showdar-router")
        : path.join(os.homedir(), ".showdar-router");

    expect(loadClient().getDataDir()).toBe(expected);
  });
});

describe("CLI API client auth file lookup", () => {
  it("reads machine-id and cli-secret from the primary dir, not DATA_DIR", () => {
    const primary = tempDir();
    const legacy = tempDir();
    writeMachineId(primary, "primary-machine");
    writeCliSecret(primary, "primary-secret");
    writeMachineId(legacy, "legacy-machine");
    writeCliSecret(legacy, "legacy-secret");
    process.env.SHOWDAR_ROUTER_DATA_DIR = primary;
    process.env.DATA_DIR = legacy;

    expect(loadClient().getCliToken()).toBe(expectedToken("primary-machine", "primary-secret"));
  });

  it("matches the server token algorithm for a DATA_DIR-only installation", () => {
    const dir = tempDir();
    writeMachineId(dir, "legacy-machine");
    writeCliSecret(dir, "legacy-secret");
    process.env.DATA_DIR = dir;
    delete process.env.SHOWDAR_ROUTER_DATA_DIR;

    expect(loadClient().getCliToken()).toBe(expectedToken("legacy-machine", "legacy-secret"));
  });

  it("produces the same token as the server for the same data dir", async () => {
    const dir = tempDir();
    writeMachineId(dir, "shared-machine");
    writeCliSecret(dir, "shared-secret");
    process.env.SHOWDAR_ROUTER_DATA_DIR = dir;
    process.env.DATA_DIR = tempDir();

    const clientToken = loadClient().getCliToken();
    const { getConsistentMachineId } = await import("../../src/shared/utils/machineId.js");

    expect(await getConsistentMachineId("9r-cli-auth")).toBe(clientToken);
  });

  it("creates a missing cli-secret in the primary dir with 0600", () => {
    const primary = tempDir();
    const legacy = tempDir();
    writeMachineId(primary, "primary-machine");
    process.env.SHOWDAR_ROUTER_DATA_DIR = primary;
    process.env.DATA_DIR = legacy;

    const token = loadClient().getCliToken();
    const secretPath = path.join(primary, "auth", "cli-secret");
    const secret = fs.readFileSync(secretPath, "utf8").trim();

    expect(token).toBe(expectedToken("primary-machine", secret));
    expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(legacy, "auth", "cli-secret"))).toBe(false);
  });
});
