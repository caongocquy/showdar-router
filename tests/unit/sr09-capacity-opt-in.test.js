// SR-09: automatic capacity-adapter fallback must be off unless the operator
// explicitly opts in. Deterministic fixtures, no network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  augmentModelsWithCapacityAdapter,
  getCapacityAdapterModels,
  getCapacityAdapterConfig,
} from "../../open-sse/services/capacityAdapter.js";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

const TEXT_ONLY = "cmc/deepseek/deepseek-v4-pro"; // no vision, no audio
const VISION_ONLY = "cmc/moonshotai/Kimi-K3";     // vision
const AUDIO_CAPABLE = "cmc/mimo-v2.5-free";       // vision + audioInput
const HIDDEN_REMOTE_DEFAULT = "oc/mimo-v2.5-free"; // old silent default endpoint

const visionReq = new Set(["vision"]);
const audioReq = new Set(["audioInput"]);

describe("SR-09 automatic capacity fallback opt-in", () => {
  it("fresh defaults keep automatic fallback off and no default-enabled pools", () => {
    const settings = mergeWithDefaults({});
    expect(settings.capacityAdapterAutoFallback).toBe(false);
    expect(settings.capacityAdapter.vision.enabled).toBe(false);
    expect(settings.capacityAdapter.audioInput.enabled).toBe(false);
  });

  it("legacy default-enabled empty pool never resolves to the hidden remote model", () => {
    const settings = {
      capacityAdapter: { vision: { enabled: true, roundRobin: false, models: [] } },
    };
    expect(getCapacityAdapterConfig("vision", settings).models).toEqual([]);
    expect(getCapacityAdapterModels(settings)).toEqual([]);
    expect(augmentModelsWithCapacityAdapter([TEXT_ONLY], visionReq, settings)).toEqual([TEXT_ONLY]);
    expect(augmentModelsWithCapacityAdapter([TEXT_ONLY], visionReq, settings)).not.toContain(HIDDEN_REMOTE_DEFAULT);
  });

  it("explicit pool models are ignored when opt-in is false", () => {
    const settings = {
      capacityAdapterAutoFallback: false,
      capacityAdapter: { vision: { enabled: true, models: [VISION_ONLY] } },
    };
    expect(augmentModelsWithCapacityAdapter([TEXT_ONLY], visionReq, settings)).toEqual([TEXT_ONLY]);
  });

  it("missing opt-in on persisted legacy config is treated as off", () => {
    const settings = { capacityAdapter: { vision: { enabled: true, models: [VISION_ONLY] } } };
    expect(augmentModelsWithCapacityAdapter([TEXT_ONLY], visionReq, settings)).toEqual([TEXT_ONLY]);
  });

  it("explicit opt-in plus explicit vision model prepends the adapter model", () => {
    const settings = {
      capacityAdapterAutoFallback: true,
      capacityAdapter: { vision: { enabled: true, models: [VISION_ONLY] } },
    };
    expect(augmentModelsWithCapacityAdapter([TEXT_ONLY], visionReq, settings)).toEqual([VISION_ONLY, TEXT_ONLY]);
  });

  it("explicit opt-in plus audio request prepends an audio-capable model", () => {
    const settings = {
      capacityAdapterAutoFallback: true,
      capacityAdapter: { audioInput: { enabled: true, models: [AUDIO_CAPABLE] } },
    };
    expect(augmentModelsWithCapacityAdapter([TEXT_ONLY], audioReq, settings)).toEqual([AUDIO_CAPABLE, TEXT_ONLY]);
  });

  it("opt-in with an empty pool still injects nothing", () => {
    const settings = {
      capacityAdapterAutoFallback: true,
      capacityAdapter: { vision: { enabled: true, roundRobin: false, models: [] } },
    };
    expect(augmentModelsWithCapacityAdapter([TEXT_ONLY], visionReq, settings)).toEqual([TEXT_ONLY]);
  });

  it("opt-in does not inject a pool model that cannot satisfy the request", () => {
    const settings = {
      capacityAdapterAutoFallback: true,
      capacityAdapter: { vision: { enabled: true, models: [TEXT_ONLY] } },
    };
    expect(augmentModelsWithCapacityAdapter([TEXT_ONLY], visionReq, settings)).toEqual([TEXT_ONLY]);
  });

  it("an explicit combo candidate is never disabled by the opt-in flag", () => {
    const settings = {
      capacityAdapterAutoFallback: false,
      capacityAdapter: { vision: { enabled: true, models: [VISION_ONLY] } },
    };
    expect(augmentModelsWithCapacityAdapter([VISION_ONLY], visionReq, settings)).toEqual([VISION_ONLY]);
  });

  it("direct single-model text requests are unaffected by the gate", () => {
    const settings = mergeWithDefaults({});
    expect(augmentModelsWithCapacityAdapter([TEXT_ONLY], new Set(), settings)).toEqual([TEXT_ONLY]);
  });
});

// Resetting Vitest's module graph alone does not close the global SQLite
// adapter. Explicitly close it before simulating a process restart or removing
// its temporary database directory (Windows keeps open files locked).
async function resetPersistenceAdapter() {
  const state = globalThis._dbAdapter;
  try {
    if (state?.initPromise) await state.initPromise;
    if (state?.instance) state.instance.close();
  } finally {
    delete globalThis._dbAdapter;
    vi.resetModules();
  }
}

describe("SR-09 opt-in persistence across restart", () => {
  let tempDir;
  let originalDataDir;

  beforeEach(async () => {
    await resetPersistenceAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr09-cap-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir;
  });

  afterEach(async () => {
    // Close DB handles before unlinking the SQLite file on Windows.
    await resetPersistenceAdapter();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists opt-in, survives restart, and can be opted back out", async () => {
    const first = await import("../../src/lib/db/repos/settingsRepo.js");
    expect((await first.getSettings()).capacityAdapterAutoFallback).toBe(false);
    await first.updateSettings({ capacityAdapterAutoFallback: true });
    await resetPersistenceAdapter(); // real close + fresh adapter on the same DB file

    const restarted = await import("../../src/lib/db/repos/settingsRepo.js");
    expect((await restarted.getSettings()).capacityAdapterAutoFallback).toBe(true);

    await restarted.updateSettings({ capacityAdapterAutoFallback: false });
    await resetPersistenceAdapter();
    const optedOut = await import("../../src/lib/db/repos/settingsRepo.js");
    expect((await optedOut.getSettings()).capacityAdapterAutoFallback).toBe(false);
  });
});
