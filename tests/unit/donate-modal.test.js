import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../src/shared/components/DonateModal.js", import.meta.url), "utf8");

describe("DonateModal QR", () => {
  it("renders the QR crop instead of the full MoMo card", () => {
    expect(source).toContain("overflow-hidden");
    expect(source).toContain("scale-[3]");
  });
});
