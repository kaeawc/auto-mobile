import { describe, expect, test } from "bun:test";
import { preparationTiming } from "../../../src/daemon/sessionBroker/preparationTiming";

describe("broker native timing bridge", () => {
  test("reads nested serial and parallel phase evidence without consuming setup timing", () => {
    expect(
      preparationTiming({
        provision: {
          timing: [
            {
              name: "provisionDevice",
              durationMs: 40,
              children: {
                create: { name: "provisionExactDevice", durationMs: 11 },
                boot: { name: "bootDevice", durationMs: 17 },
                ready: { name: "ensureCtrlProxy iOS", durationMs: 12 },
              },
            },
          ],
        },
      }),
    ).toEqual({ createMs: 11, bootMs: 17, automationReadyMs: 12 });
  });
  test.each([
    undefined,
    {},
    { provision: { timing: null } },
    { provision: { timing: [{ name: "bootDevice", durationMs: -1 }] } },
  ])("unmeasured or malformed evidence does not manufacture zero phases: %j", (value) => {
    expect(preparationTiming(value)).toBeUndefined();
  });
});
