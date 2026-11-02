import { describe, expect, test } from "bun:test";
import {
  ambientSchema,
  ambientResultSchema,
  createAmbientHandler,
} from "../../src/server/ambientTool";
import { ActionableError, type BootedDevice } from "../../src/models";
import type { Ambient, AmbientAction } from "../../src/features/wear/Ambient";
import { toolJson } from "../helpers/toolResponse";

const android: BootedDevice = { name: "Wear", deviceId: "fake-watch", platform: "android" };

describe("ambient tool", () => {
  test("strict schema accepts only enter or exit", () => {
    for (const action of ["enter", "exit"]) {
      expect(ambientSchema.safeParse({ action }).success).toBe(true);
    }
    for (const input of [
      { action: "toggle" },
      { action: 1 },
      {},
      { action: "enter", extra: true },
    ]) {
      expect(ambientSchema.safeParse(input).success).toBe(false);
    }
  });

  test.each([true, false])(
    "returns structured success=%s with failure marked as error",
    async (success) => {
      const calls: AmbientAction[] = [];
      const port: Ambient = {
        change: async (action) => {
          calls.push(action);
          return {
            success,
            action,
            wakefulness: "Awake",
            message:
              "power-state change; Wear exposes no ambient readback; this does not prove ambient mode.",
            ...(success ? {} : { reason: "Observed wakefulness Awake" }),
          };
        },
      };
      const response = await createAmbientHandler(() => port)(android, { action: "enter" });
      expect(calls).toEqual(["enter"]);
      expect(ambientResultSchema.safeParse(toolJson(response)).success).toBe(true);
      expect(toolJson(response).success).toBe(success);
      expect(response.isError ?? false).toBe(!success);
    },
  );

  test("iOS is refused before constructing the port", async () => {
    const handler = createAmbientHandler(() => {
      throw new Error("must not construct");
    });
    await expect(
      handler({ ...android, platform: "ios" }, { action: "enter" }),
    ).rejects.toBeInstanceOf(ActionableError);
  });

  test("adb failures at the tool boundary become actionable", async () => {
    const port: Ambient = {
      change: async () => {
        throw new Error("device offline");
      },
    };
    await expect(
      createAmbientHandler(() => port)(android, { action: "exit" }),
    ).rejects.toBeInstanceOf(ActionableError);
  });
});
