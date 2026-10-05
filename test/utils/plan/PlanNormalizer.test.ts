import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import { PlanNormalizer } from "../../../src/utils/plan/PlanNormalizer";

describe("PlanNormalizer", () => {
  test("logs only the tool name and index once at info", () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const normalized = PlanNormalizer.normalizeStep({ tool: "inputText", text: "hunter2" }, 0);

      expect(normalized).toEqual({ tool: "inputText", params: { text: "hunter2" } });
      expect(info.mock.calls.flat().some((argument) => String(argument).includes("hunter2"))).toBe(
        false,
      );
      expect(info.mock.calls).toEqual([["Normalized step 0: inputText"]]);
    } finally {
      info.mockRestore();
      debug.mockRestore();
    }
  });

  test("keeps the raw and normalized JSON dumps at debug", () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const step = { tool: "inputText", text: "hunter2" };
      const normalized = PlanNormalizer.normalizeStep(step, 0);

      expect(debug.mock.calls).toEqual([
        ["Processing step 0:", JSON.stringify(step, null, 2)],
        ["Normalized step 0:", JSON.stringify(normalized, null, 2)],
      ]);
      expect(debug.mock.calls.every(([, dump]) => String(dump).includes("hunter2"))).toBe(true);
    } finally {
      info.mockRestore();
      debug.mockRestore();
    }
  });

  test("preserves command, params, label, and optional mapping", () => {
    expect(
      PlanNormalizer.normalizeStep(
        {
          command: "inputText",
          text: "inline",
          params: { text: "hunter2" },
          label: "Enter text",
          optional: true,
        },
        3,
      ),
    ).toEqual({
      tool: "inputText",
      params: { text: "hunter2" },
      label: "Enter text",
      optional: true,
    });
  });

  test("logs one info summary per step when normalizing two steps", () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const normalized = PlanNormalizer.normalizeSteps([
        { tool: "inputText", text: "hunter2" },
        { tool: "tapOn", text: "Submit" },
      ]);

      expect(normalized).toEqual([
        { tool: "inputText", params: { text: "hunter2" } },
        { tool: "tapOn", params: { text: "Submit" } },
      ]);
      expect(info.mock.calls).toEqual([
        ["Normalized step 0: inputText"],
        ["Normalized step 1: tapOn"],
      ]);
    } finally {
      info.mockRestore();
      debug.mockRestore();
    }
  });

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

  test("toolAndParams merges inline fields under explicit params without logging or throwing", () => {
    expect(
      PlanNormalizer.toolAndParams({ command: "tapOn", text: "a", params: { text: "b", id: 1 } }),
    ).toEqual({ tool: "tapOn", params: { text: "b", id: 1 } });
    for (const invalid of [null, undefined, 1, "x", [], {}, { tool: 5 }]) {
      expect(PlanNormalizer.toolAndParams(invalid)).toBeUndefined();
    }
  });
});
