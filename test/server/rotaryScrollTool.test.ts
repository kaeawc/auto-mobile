import { describe, expect, test } from "bun:test";
import {
  createRotaryScrollHandler,
  rotaryScrollResultSchema,
  rotaryScrollSchema,
  traitsWatchCheck,
  type WatchCheck,
} from "../../src/server/rotaryScrollTool";
import { DEVICE_TRAITS_TIMEOUT_MS } from "../../src/server/bootedDeviceTraits";
import { androidDeviceTraits, FakeDeviceTraits } from "../fakes/FakeDeviceTraits";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { ActionableError, type BootedDevice } from "../../src/models";
import type { RotaryScroller, RotaryScrollResult } from "../../src/features/wear/RotaryScroll";
import { screenFingerprint } from "../../src/server/rotaryScrollTool";
import { AdbRotaryScroller } from "../../src/features/wear/RotaryScroll";
import type { ObserveResult } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { toolJson } from "../helpers/toolResponse";

const android: BootedDevice = { name: "Wear", deviceId: "emulator-5554", platform: "android" };
const ios: BootedDevice = { name: "iPhone", deviceId: "sim-1", platform: "ios" };

function setup(result: RotaryScrollResult, watch: boolean | "unreadable" = true) {
  const calls: number[] = [];
  const watchChecks: string[] = [];
  const scroller: RotaryScroller = {
    scroll: async ({ delta }) => {
      calls.push(delta);
      return result;
    },
  };
  const checkWatch: WatchCheck = async (device) => {
    watchChecks.push(device.deviceId);
    return watch === "unreadable" ? undefined : watch;
  };
  return { calls, watchChecks, handler: createRotaryScrollHandler(() => scroller, checkWatch) };
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

  test("is Android-only, refused before the watch check", async () => {
    const { handler, watchChecks } = setup({ success: true, delta: 1, attempts: [] });
    await expect(handler(ios, { delta: 1 })).rejects.toBeInstanceOf(ActionableError);
    expect(watchChecks).toEqual([]);
  });

  test("a watch gets no warning", async () => {
    const { handler, watchChecks } = setup(scrolled, true);
    const json = toolJson(await handler(android, { delta: 2 }));
    expect(watchChecks).toEqual(["emulator-5554"]);
    expect(json.success).toBe(true);
    expect(json).not.toHaveProperty("warning");
  });

  test("a non-watch device still scrolls but the result warns", async () => {
    const { handler, calls } = setup(scrolled, false);
    const json = toolJson(await handler(android, { delta: 2 }));
    expect(calls).toEqual([2]);
    expect(json.success).toBe(true);
    expect(json.warning).toContain("does not announce a watch build");
    expect(rotaryScrollResultSchema.safeParse(json).success).toBe(true);
  });

  test("unreadable traits still scroll and warn that the watch is unconfirmed", async () => {
    const { handler, calls } = setup(scrolled, "unreadable");
    const json = toolJson(await handler(android, { delta: 2 }));
    expect(calls).toEqual([2]);
    expect(json.warning).toContain("Could not read the device traits");
  });

  test("delta must be a non-zero integer within the cap", () => {
    expect(rotaryScrollSchema.safeParse({ delta: 5 }).success).toBe(true);
    expect(rotaryScrollSchema.safeParse({ delta: -50 }).success).toBe(true);
    expect(rotaryScrollSchema.safeParse({ delta: 0 }).success).toBe(false);
    expect(rotaryScrollSchema.safeParse({ delta: 51 }).success).toBe(false);
    expect(rotaryScrollSchema.safeParse({ delta: 1.5 }).success).toBe(false);
  });
});

describe("traitsWatchCheck", () => {
  test("reads the device traits once with the traits timeout", async () => {
    const traits = new FakeDeviceTraits(androidDeviceTraits({ formFactor: "watch" }));
    const check = traitsWatchCheck(traits, new FakeAdbClientFactory());
    expect(await check(android)).toBe(true);
    expect(traits.reads).toEqual([
      { deviceId: "emulator-5554", options: { timeoutMs: DEVICE_TRAITS_TIMEOUT_MS } },
    ]);
  });

  test("a phone and an automotive build are not watches", async () => {
    const traits = new FakeDeviceTraits(androidDeviceTraits({ formFactor: null }));
    const check = traitsWatchCheck(traits, new FakeAdbClientFactory());
    expect(await check(android)).toBe(false);
    traits.setTraits(androidDeviceTraits({ formFactor: "automotive" }));
    expect(await check(android)).toBe(false);
  });

  test("a failed traits read is undefined, not a rejection", async () => {
    const traits = new FakeDeviceTraits(new Error("getprop timed out"));
    const check = traitsWatchCheck(traits, new FakeAdbClientFactory());
    expect(await check(android)).toBeUndefined();
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
