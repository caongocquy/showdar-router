import { afterEach, describe, expect, it, vi } from "vitest";
import { selectMenu } from "../../cli/src/cli/utils/input.js";

describe("CLI input cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("releases raw stdin after selecting an interface", async () => {
    const isTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    const setRawMode = vi.fn(() => process.stdin);
    const resume = vi.fn(() => process.stdin);
    const pause = vi.fn(() => process.stdin);
    process.stdin.setRawMode = setRawMode;
    vi.spyOn(process.stdin, "resume").mockImplementation(resume);
    vi.spyOn(process.stdin, "pause").mockImplementation(pause);

    const selection = selectMenu("Choose", [{ label: "Exit" }]);
    process.stdin.emit("keypress", "\r", { name: "return" });

    await expect(selection).resolves.toBe(0);
    expect(setRawMode).toHaveBeenLastCalledWith(false);
    expect(pause).toHaveBeenCalled();
    expect(resume).toHaveBeenCalled();
    expect(process.stdin.listenerCount("data")).toBe(0);

    if (isTTY) Object.defineProperty(process.stdin, "isTTY", isTTY);
  });
});
