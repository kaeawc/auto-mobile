import { describe, expect, test } from "bun:test";
import {
  createRotaryScrollHandler,
  rotaryScrollResultSchema,
  rotaryScrollSchema,
} from "../../src/server/rotaryScrollTool";
import { traitsFormFactorRead, type FormFactorRead } from "../../src/server/requireWatch";
import type { TraitFormFactor } from "../../src/utils/android-cmdline-tools/deviceTraits";
import { DEVICE_TRAITS_TIMEOUT_MS } from "../../src/server/bootedDeviceTraits";
import { androidDeviceTraits, FakeDeviceTraits } from "../fakes/FakeDeviceTraits";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import type { BootedDevice } from "../../src/models";
import type { RotaryScroller, RotaryScrollResult } from "../../src/features/wear/RotaryScroll";
import { screenFingerprint } from "../../src/server/rotaryScrollTool";
import { AdbRotaryScroller } from "../../src/features/wear/RotaryScroll";
import type { ObserveResult } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { toolJson } from "../helpers/toolResponse";

const android: BootedDevice = { name: "Wear", deviceId: "emulator-5554", platform: "android" };

function setup(
  result: RotaryScrollResult,
  formFactor: TraitFormFactor | null | "unreadable" = "watch",
) {
  const calls: number[] = [];
  const reads: string[] = [];
  const scroller: RotaryScroller = {
    scroll: async ({ delta }) => {
      calls.push(delta);
      return result;
    },
  };
  const readFormFactor: FormFactorRead = async (device) => {
    reads.push(device.deviceId);
    return formFactor === "unreadable" ? undefined : formFactor;
  };
  return { calls, reads, handler: createRotaryScrollHandler(() => scroller, readFormFactor) };
}

const scrolled: RotaryScrollResult = {
  success: true,
  delta: 2,
  method: "input_rotaryencoder",
  attempts: [
    {
      method: "input_rotaryencoder",
      command: "shell input rotaryencoder scroll --axis SCROLL,-2",
      outcome: "scrolled",
    },
  ],
};

describe("rotaryScroll tool", () => {
  test("reports the working method and the attempts", async () => {
    const { calls, handler } = setup({
      success: true,
      delta: 3,
      method: "swipe",
      attempts: [
        {
          method: "input_rotaryencoder",
          command: "shell input rotaryencoder scroll --axis SCROLL,-3",
          outcome: "failed",
          error: "Error",
        },
        { method: "swipe", command: "shell input swipe 1 2 3 4 250", outcome: "scrolled" },
      ],
    });
    const response = await handler(android, { delta: 3 });
    const json = toolJson(response);
    expect(rotaryScrollResultSchema.safeParse(json).success).toBe(true);
    expect(calls).toEqual([3]);
    expect(json.success).toBe(true);
    expect(json.method).toBe("swipe");
    expect((json.attempts as unknown[]).length).toBe(2);
  });

  test("a call where nothing moved the screen is an error response with a reason", async () => {
    const { handler } = setup({
      success: false,
      delta: 1,
      attempts: [],
      reason: "No rotary candidate changed the screen on read-back.",
    });
    const response = await handler(android, { delta: 1 });
    expect((response as { isError?: boolean }).isError).toBe(true);
    expect(toolJson(response).reason).toContain("No rotary candidate");
  });

  test("a watch scrolls after one form-factor read", async () => {
    const { handler, reads, calls } = setup(scrolled, "watch");
    const json = toolJson(await handler(android, { delta: 2 }));
    expect(reads).toEqual(["emulator-5554"]);
    expect(calls).toEqual([2]);
    expect(json.success).toBe(true);
    expect(rotaryScrollResultSchema.safeParse(json).success).toBe(true);
  });

  for (const formFactor of ["tablet", "foldable", "automotive", "tv"] as const) {
    test(`a ${formFactor} is refused before any input is sent`, async () => {
      const { handler, calls } = setup(scrolled, formFactor);
      await expect(handler(android, { delta: 3 })).rejects.toThrow(
        `rotaryScroll requires a Wear OS watch; this device's form factor is ${formFactor}, so nothing was changed.`,
      );
      expect(calls).toEqual([]);
    });
  }

  test("a phone (no characteristics announced) is refused without input", async () => {
    const { handler, calls } = setup(scrolled, null);
    await expect(handler({ ...android, formFactor: "phone" }, { delta: 3 })).rejects.toThrow(
      "rotaryScroll requires a Wear OS watch; this device's form factor is phone",
    );
    expect(calls).toEqual([]);
  });

  test("unreadable traits on a session not recorded as a watch are refused", async () => {
    const { handler, calls } = setup(scrolled, "unreadable");
    await expect(handler(android, { delta: 2 })).rejects.toThrow(
      "The device traits could not be read",
    );
    expect(calls).toEqual([]);
  });

  test("unreadable traits on a session recorded as a watch still scroll", async () => {
    const { handler, calls } = setup(scrolled, "unreadable");
    const json = toolJson(await handler({ ...android, formFactor: "watch" }, { delta: 2 }));
    expect(calls).toEqual([2]);
    expect(json.success).toBe(true);
  });

  test("delta must be a non-zero integer within the cap", () => {
    expect(rotaryScrollSchema.safeParse({ delta: 5 }).success).toBe(true);
    expect(rotaryScrollSchema.safeParse({ delta: -50 }).success).toBe(true);
    expect(rotaryScrollSchema.safeParse({ delta: 0 }).success).toBe(false);
    expect(rotaryScrollSchema.safeParse({ delta: 51 }).success).toBe(false);
    expect(rotaryScrollSchema.safeParse({ delta: 1.5 }).success).toBe(false);
  });
});

describe("rotaryScroll default form-factor read", () => {
  test("reads the device traits once with the traits timeout", async () => {
    const traits = new FakeDeviceTraits(androidDeviceTraits({ formFactor: "watch" }));
    const read = traitsFormFactorRead(traits, new FakeAdbClientFactory(), "rotaryScroll");
    expect(await read(android)).toBe("watch");
    expect(traits.reads).toEqual([
      { deviceId: "emulator-5554", options: { timeoutMs: DEVICE_TRAITS_TIMEOUT_MS } },
    ]);
  });
});

describe("screenFingerprint", () => {
  const unavailable = (detail: string): Pick<ObserveResult, "viewHierarchy"> => ({
    viewHierarchy: { hierarchy: { error: "CtrlProxy disconnected", unavailableDetail: detail } },
  });

  test("an error-shaped hierarchy is unavailable, whatever its detail", () => {
    expect(screenFingerprint(unavailable("a"))).toBeUndefined();
    expect(screenFingerprint(unavailable("b"))).toBeUndefined();
    expect(screenFingerprint({ viewHierarchy: undefined })).toBeUndefined();
  });

  test("a changing diagnostic never reports a scroll and no input is sent", async () => {
    const commands: string[] = [];
    let n = 0;
    const result = await new AdbRotaryScroller({
      adb: {
        executeCommand: async (command) => {
          commands.push(command);
          return {
            stdout: "",
            stderr: "",
            toString: () => "",
            trim: () => "",
            includes: () => false,
          };
        },
      },
      timer: new FakeTimer(),
      deviceId: "emulator-5554",
      fingerprint: async () => screenFingerprint(unavailable(`detail ${(n += 1)}`)),
    }).scroll({ delta: 1 });

    expect(result.success).toBe(false);
    expect(result.attempts).toEqual([]);
    expect(result.reason).toContain("could not be read");
    expect(commands).toEqual([]);
  });
});
