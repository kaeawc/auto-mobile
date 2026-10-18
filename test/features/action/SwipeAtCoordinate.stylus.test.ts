import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import type { SwipeAtOptions } from "../../../src/models/SwipeAtOptions";
import { createSwipeAt } from "../../helpers/swipeAtCoordinate";

const ANDROID: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };
const IOS: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "ios-1" };

const stylusSwipe = (extra: Partial<SwipeAtOptions> = {}): SwipeAtOptions =>
  ({
    from: { x: 10, y: 20 },
    to: { x: 60, y: 120 },
    durationMs: 250,
    pointer: { toolType: "stylus" },
    ...extra,
  }) as SwipeAtOptions;

function androidWithSdk(level: number | null) {
  const fake = createSwipeAt(ANDROID);
  fake.adb.setAndroidApiLevel(level);
  return fake;
}

describe("swipeAt stylus pointer (#13081)", () => {
  test("dispatches through the stylus input source and never the finger gesture", async () => {
    const fake = androidWithSdk(34);
    const result = await fake.swipeAt.execute(stylusSwipe());

    expect(result.success).toBe(true);
    expect(fake.adb.getExecutedCommands()).toContain("shell input stylus swipe 10 20 60 120 250");
    expect(fake.swipes).toEqual([]);
    expect(result).toMatchObject({ x1: 10, y1: 20, x2: 60, y2: 120, duration: 250 });
  });

  test("without a pointer the finger gesture is used and no stylus command is sent", async () => {
    const fake = androidWithSdk(34);
    const result = await fake.swipeAt.execute({
      from: { x: 10, y: 20 },
      to: { x: 60, y: 120 },
      durationMs: 250,
    });

    expect(result.success).toBe(true);
    expect(fake.swipes).toHaveLength(1);
    expect(fake.adb.getExecutedCommands().some((c) => c.includes("stylus"))).toBe(false);
  });

  test.each([
    [
      "pressure other than 1.0",
      stylusSwipe({ pointer: { toolType: "stylus", pressure: 0.5 } }),
      34,
    ],
    ["a panel selection", stylusSwipe({ display: "cover" }), 34],
    ["an Android release before 31", stylusSwipe(), 30],
    ["an unreadable SDK", stylusSwipe(), null],
  ] as const)(
    "%s fails with a capability error and injects nothing",
    async (_name, options, sdk) => {
      const fake = androidWithSdk(sdk);
      const result = await fake.swipeAt.execute(options);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(fake.swipes).toEqual([]);
      // No input of any kind, finger or stylus: only the device read may have run.
      expect(fake.adb.getExecutedCommands().filter((c) => c.includes("input"))).toEqual([]);
    },
  );

  test("iOS fails as Android-only and sends no gesture", async () => {
    const fake = createSwipeAt(IOS);
    const result = await fake.swipeAt.execute(stylusSwipe());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Android-only");
    expect(fake.swipes).toEqual([]);
  });

  test("a swipe that fails after the command was sent is indeterminate", async () => {
    const fake = androidWithSdk(34);
    fake.adb.setCommandError("input stylus swipe", new Error("adb connection lost"));
    const result = await fake.swipeAt.execute(stylusSwipe());

    expect(result.success).toBe(false);
    expect(result.outcomeIndeterminate).toBe(true);
    expect(result.error).toContain("do not retry automatically");
    expect(fake.swipes).toEqual([]);
  });

  test("a cancellation after the command was sent is indeterminate, not a retryable abort", async () => {
    const fake = androidWithSdk(34);
    fake.adb.setCommandError(
      "input stylus swipe",
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );
    const result = await fake.swipeAt.execute(stylusSwipe());

    expect(result.success).toBe(false);
    expect(result.outcomeIndeterminate).toBe(true);
  });

  test("a command the device rejected is not indeterminate, so a retry is safe", async () => {
    const fake = androidWithSdk(34);
    fake.adb.setCommandResponse("input stylus swipe", {
      stdout: "",
      stderr: "Error: unknown source",
    } as never);
    const result = await fake.swipeAt.execute(stylusSwipe());

    expect(result.success).toBe(false);
    expect(result.outcomeIndeterminate).toBeUndefined();
  });

  test("a failing stylus command reports the failure instead of falling back to a finger", async () => {
    const fake = androidWithSdk(34);
    fake.adb.setCommandResponse("input stylus swipe", {
      stdout: "",
      stderr: "Error: unknown source",
    } as never);
    const result = await fake.swipeAt.execute(stylusSwipe());

    expect(result.success).toBe(false);
    expect(fake.swipes).toEqual([]);
  });
});
