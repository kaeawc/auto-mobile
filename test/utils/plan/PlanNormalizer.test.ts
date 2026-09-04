import { describe, expect, test } from "bun:test";
import { PlanNormalizer } from "../../../src/utils/plan/PlanNormalizer";

describe("PlanNormalizer", () => {
  test("merges inline fields into params", () => {
    const normalized = PlanNormalizer.normalizeStep(
      { tool: "tapOn", text: "Hello", device: "A" },
      0,
    );

    expect(normalized.tool).toBe("tapOn");
    expect(normalized.params).toEqual({ text: "Hello", device: "A" });
  });

  test("prefers explicit params over inline fields", () => {
    const normalized = PlanNormalizer.normalizeStep(
      {
        tool: "tapOn",
        text: "inline",
        params: { text: "params", device: "B" },
        label: "Tap button",
      },
      0,
    );

    expect(normalized.params).toEqual({ text: "params", device: "B" });
    expect(normalized.label).toBe("Tap button");
  });

  test("params.networkCondition wins over an inline networkCondition (#6090 review)", () => {
    const normalized = PlanNormalizer.normalizeStep(
      {
        tool: "setDeviceState",
        networkCondition: { profile: "offline", delayMs: 500 },
        params: { networkCondition: { profile: "none" } },
      },
      0,
    );

    // The inline value is fully discarded — the step executes as the valid reset,
    // which is why the schema must not false-reject the overridden inline form.
    expect(normalized.params).toEqual({ networkCondition: { profile: "none" } });
  });

  test("promotes optional flag to the step, not into tool params", () => {
    const normalized = PlanNormalizer.normalizeStep(
      { tool: "tapOn", text: "Not Now", optional: true },
      0,
    );

    expect(normalized.optional).toBe(true);
    // `optional` is a step-level concern; it must not leak into the tool schema (tapOn is strict).
    expect(normalized.params).toEqual({ text: "Not Now" });
  });

  test("omits optional when not set to true", () => {
    const normalized = PlanNormalizer.normalizeStep({ tool: "observe" }, 0);

    expect(normalized.optional).toBeUndefined();
  });
});
