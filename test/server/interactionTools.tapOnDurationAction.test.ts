import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ActionableError } from "../../src/models/ActionableError";
import type { BootedDevice, TapOnElementOptions } from "../../src/models";
import type { InteractionToolDependencies } from "../../src/server/interactionTools/dependencies";
import { tapOnHandler } from "../../src/server/interactionTools/tapHandlers";
import { tapOnSchema } from "../../src/server/interactionTools/tapSchemas";
import { migratePlan } from "../../src/utils/plan/PlanMigrator";

describe.each(["android", "ios"] as const)("tapOn duration action on %s", (platform) => {
  const device: BootedDevice = { deviceId: "fake", name: "fake", platform };
  const received: TapOnElementOptions[] = [];
  const factory = mock<NonNullable<InteractionToolDependencies["tapOnElementFactory"]>>(() => ({
    execute: async (options) => {
      received.push(options);
      return {
        success: true,
        action: options.action ?? "tap",
        element: { text: "Target", bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
      };
    },
  }));
  const deps: InteractionToolDependencies = { tapOnElementFactory: factory };

  beforeEach(() => {
    received.length = 0;
    factory.mockClear();
  });

  describe("schema inferred action", () => {
    test.each([1, 499])("refuses inferred longPress duration %i below the minimum", (duration) => {
      const result = tapOnSchema.safeParse({
        platform,
        selector: { text: "Target" },
        duration,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            code: "custom",
            path: ["duration"],
            message: "longPress duration must be 0 (platform default) or at least 500 ms",
          }),
        );
      }
    });

    test.each([0, 500, undefined])("accepts duration %s", (duration) => {
      expect(
        tapOnSchema.safeParse({ platform, selector: { text: "Target" }, duration }).success,
      ).toBe(true);
    });
  });

  test.each([0, 1, 200, 499, 500, undefined])(
    "accepts explicit longPress duration %s",
    (duration) => {
      expect(
        tapOnSchema.safeParse({
          platform,
          selector: { text: "Target" },
          action: "longPress",
          duration,
        }).success,
      ).toBe(true);
    },
  );

  test.each([true, false])("refuses inferred longPress with ensureChecked=%s", (ensureChecked) => {
    const result = tapOnSchema.safeParse({
      platform,
      selector: { text: "Target" },
      duration: 750,
      ensureChecked,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          code: "custom",
          path: ["ensureChecked"],
          message: 'ensureChecked requires action "tap"',
        }),
      );
    }
  });

  test.each([
    ["direct accessibilityLink", { selector: { accessibilityLink: "Terms of Service" } }],
    [
      "owner-scoped semantic link",
      { selector: { text: "Legal" }, subtext: { text: "Terms of Service" } },
    ],
  ] as const)("refuses inferred longPress with %s", (_label, options) => {
    const result = tapOnSchema.safeParse({ platform, duration: 750, ...options });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          code: "custom",
          path: ["action"],
          message: "semantic link activation supports only the tap action",
        }),
      );
    }
  });

  test.each([
    ["positive duration without action infers longPress", { duration: 750 }, "longPress"],
    ["explicit longPress keeps its duration", { action: "longPress", duration: 750 }, "longPress"],
    ["omitted action and duration defaults to tap", {}, "tap"],
    ["zero duration without action defaults to tap", { duration: 0 }, "tap"],
    ["explicit tap accepts zero duration", { action: "tap", duration: 0 }, "tap"],
  ] as const)("%s", async (_label, options, expectedAction) => {
    const args = tapOnSchema.parse({ selector: { text: "Target" }, ...options });

    await tapOnHandler(device, args, { deps });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    expect(received[0].action).toBe(expectedAction);
    expect(received[0].duration).toBe("duration" in options ? options.duration : undefined);
  });

  test("refuses explicit tap with positive duration before calling the factory", async () => {
    const args = tapOnSchema.parse({
      selector: { text: "Target" },
      action: "tap",
      duration: 750,
    });

    const call = tapOnHandler(device, args, { deps });

    await expect(call).rejects.toBeInstanceOf(ActionableError);
    await expect(call).rejects.toThrow(
      'duration applies only to longPress; pass action: "longPress" or omit duration',
    );
    expect(factory).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  test("a migrated duration-only plan step reaches the factory as longPress", async () => {
    const { plan } = migratePlan({
      name: "Duration-only press",
      steps: [{ tool: "tapOn", params: { selector: { text: "Target" }, duration: 750 } }],
    });
    const args = tapOnSchema.parse(plan.steps[0].params);

    await tapOnHandler(device, args, { deps });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    expect(received[0].action).toBe("longPress");
    expect(received[0].duration).toBe(750);
  });
});
