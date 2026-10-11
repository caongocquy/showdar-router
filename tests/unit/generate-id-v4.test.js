import { describe, expect, it } from "vitest";
import { generateId } from "@/shared/utils/index.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("generateId (crypto.randomUUID)", () => {
  it("returns an RFC 4122 UUID v4", () => {
    expect(generateId()).toMatch(UUID_V4);
  });

  it("is unique across calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});
