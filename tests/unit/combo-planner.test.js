import { describe, it, expect } from "vitest";
import { planComboCandidates } from "../../open-sse/services/comboPlanner.js";

describe("combo candidate planner", () => {
  it("drops models missing a hard capability while preserving order", async () => {
    const plan = await planComboCandidates({
      models: ["p/text", "p/vision", "p/vision-2"],
      requiredCapabilities: new Set(["vision"]),
      inspectHealth: async () => ({ skip: false }),
      getCapabilities: (_provider, model) => ({ vision: model !== "text" }),
    });

    expect(plan.models).toEqual(["p/vision", "p/vision-2"]);
    expect(plan.missingCapabilities).toEqual([]);
  });

  it("reports a capability mismatch separately from route outage", async () => {
    const plan = await planComboCandidates({
      models: ["p/text"],
      requiredCapabilities: new Set(["vision"]),
      inspectHealth: async () => ({ skip: false }),
      getCapabilities: () => ({ vision: false }),
    });

    expect(plan.models).toEqual([]);
    expect(plan.missingCapabilities).toEqual(["vision"]);
    expect(plan.routeUnavailable).toBe(false);
  });
});
