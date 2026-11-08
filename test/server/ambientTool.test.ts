import { describe, expect, test } from "bun:test";
import {
  ambientSchema,
  ambientResultSchema,
  createAmbientHandler,
  traitsFormFactorRead,
  type FormFactorRead,
} from "../../src/server/ambientTool";
import { ActionableError, type BootedDevice } from "../../src/models";
import type { Ambient, AmbientAction } from "../../src/features/wear/Ambient";
import type { TraitFormFactor } from "../../src/utils/android-cmdline-tools/deviceTraits";
import { androidDeviceTraits, FakeDeviceTraits } from "../fakes/FakeDeviceTraits";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { toolJson } from "../helpers/toolResponse";

const android: BootedDevice = { name: "Wear", deviceId: "fake-watch", platform: "android" };
const announces =
  (formFactor: TraitFormFactor | null | undefined): FormFactorRead =>
  async () =>
    formFactor;
const watch = announces("watch");

function recordingPort(calls: AmbientAction[]): Ambient {
  return {
    change: async (action) => {
      calls.push(action);
      return { success: true, action, wakefulness: "Dozing", message: "changed" };
    },
  };
}

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
      const response = await createAmbientHandler(() => port, watch)(android, { action: "enter" });
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
      createAmbientHandler(() => port, watch)(android, { action: "exit" }),
    ).rejects.toBeInstanceOf(ActionableError);
  });

  test.each<[string, TraitFormFactor | null | undefined, BootedDevice["formFactor"], RegExp]>([
    ["a phone build", null, "phone", /form factor is phone,/],
    ["an unrecorded non-watch build", null, undefined, /form factor is phone or tablet/],
    ["a TV build", "tv", undefined, /form factor is tv,/],
    ["unreadable traits", undefined, undefined, /form factor is unknown.*could not be read/],
  ])("%s is refused before any power-state change", async (_label, announced, recorded, text) => {
    const calls: AmbientAction[] = [];
    const device: BootedDevice = { ...android, formFactor: recorded };
    const call = createAmbientHandler(() => recordingPort(calls), announces(announced))(device, {
      action: "enter",
    });
    await expect(call).rejects.toBeInstanceOf(ActionableError);
    await expect(call).rejects.toThrow(text);
    await expect(call).rejects.toThrow(/nothing was changed/);
    expect(calls).toEqual([]);
  });

  test.each<[string, TraitFormFactor | null | undefined]>([
    ["unreadable traits", undefined],
    ["a null form factor (characteristics getprop may have failed)", null],
  ])("a recorded watch is allowed with %s", async (_label, announced) => {
    const calls: AmbientAction[] = [];
    const response = await createAmbientHandler(() => recordingPort(calls), announces(announced))(
      { ...android, formFactor: "watch" },
      { action: "enter" },
    );
    expect(calls).toEqual(["enter"]);
    expect(toolJson(response).success).toBe(true);
  });

  test("a recorded watch is refused when the build names another form factor", async () => {
    const calls: AmbientAction[] = [];
    const call = createAmbientHandler(() => recordingPort(calls), announces("tv"))(
      { ...android, formFactor: "watch" },
      { action: "enter" },
    );
    await expect(call).rejects.toThrow(/form factor is tv,/);
    expect(calls).toEqual([]);
  });

  test("the traits reader reports the announced form factor and undefined on a failed read", async () => {
    const traits = new FakeDeviceTraits(androidDeviceTraits({ formFactor: "watch" }));
    const read = traitsFormFactorRead(traits, new FakeAdbClientFactory());
    expect(await read(android)).toBe("watch");
    traits.setTraits(androidDeviceTraits({ formFactor: null }));
    expect(await read(android)).toBeNull();
    const failing = traitsFormFactorRead(
      new FakeDeviceTraits(new Error("getprop timed out")),
      new FakeAdbClientFactory(),
    );
    expect(await failing(android)).toBeUndefined();
  });
});
