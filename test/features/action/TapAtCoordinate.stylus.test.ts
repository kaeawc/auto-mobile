import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import type { TapAtOptions } from "../../../src/models/TapAtOptions";
import { createTapAt } from "../../helpers/tapAtCoordinate";

const ANDROID: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };
const IOS: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "ios-1" };

const stylusTap = (extra: Partial<TapAtOptions> = {}): TapAtOptions =>
  ({ x: 4, y: 6, pointer: { toolType: "stylus" }, ...extra }) as TapAtOptions;

function androidWithSdk(level: number | null) {
  const fake = createTapAt(ANDROID);
  fake.adb.setAndroidApiLevel(level);
  return fake;
}

describe("tapAt stylus pointer (#13081)", () => {
  test("a tap goes through the stylus input source, not the finger dispatch", async () => {
    const fake = androidWithSdk(34);
    const result = await fake.tapAt.execute(stylusTap());

    expect(result.success).toBe(true);
    expect(fake.adb.getExecutedCommands()).toContain("shell input stylus tap 4 6");
    expect(fake.androidDispatches).toEqual([]);
  });

  test("a long press is a zero-distance stylus swipe with the duration", async () => {
    const fake = androidWithSdk(34);
    const result = await fake.tapAt.execute(stylusTap({ action: "longPress", durationMs: 800 }));

    expect(result.success).toBe(true);
    expect(fake.adb.getExecutedCommands()).toContain("shell input stylus swipe 4 6 4 6 800");
    expect(fake.androidDispatches).toEqual([]);
  });

  test("without a pointer the finger dispatch is used and no stylus command is sent", async () => {
    const fake = androidWithSdk(34);
    const result = await fake.tapAt.execute({ x: 4, y: 6 });

    expect(result.success).toBe(true);
    expect(fake.androidDispatches).toHaveLength(1);
    expect(fake.adb.getExecutedCommands().some((c) => c.includes("stylus"))).toBe(false);
  });

  test.each([
    ["pressure other than 1.0", stylusTap({ pointer: { toolType: "stylus", pressure: 0.5 } }), 34],
    ["doubleTap", stylusTap({ action: "doubleTap" }), 34],
    ["a panel selection", stylusTap({ display: "cover" }), 34],
    ["an Android release before 31", stylusTap(), 30],
    ["an unreadable SDK", stylusTap(), null],
  ] as const)(
    "%s fails with a capability error and injects nothing",
    async (_name, options, sdk) => {
      const fake = androidWithSdk(sdk);
      const result = await fake.tapAt.execute(options);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(fake.androidDispatches).toEqual([]);
      expect(fake.adb.getExecutedCommands().filter((c) => c.includes("input"))).toEqual([]);
    },
  );

  test("iOS fails as Android-only and dispatches nothing", async () => {
    const fake = createTapAt(IOS);
    const result = await fake.tapAt.execute(stylusTap());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Android-only");
    expect(fake.iosDispatches).toEqual([]);
  });

  test.each([
    ["a tap", stylusTap(), "input stylus tap"],
    ["a long press", stylusTap({ action: "longPress", durationMs: 800 }), "input stylus swipe"],
  ] as const)(
    "%s that fails after the command was sent is indeterminate: do not retry",
    async (_name, options, pattern) => {
      const fake = androidWithSdk(34);
      fake.adb.setCommandError(pattern, new Error("adb connection lost"));
      const result = await fake.tapAt.execute(options);

      expect(result.success).toBe(false);
      expect(result.error).toContain("indeterminate");
      expect(result.error).toContain("Do not retry automatically");
      expect(fake.androidDispatches).toEqual([]);
    },
  );

  test("a cancellation after the command was sent is indeterminate, not a retryable abort", async () => {
    const fake = androidWithSdk(34);
    fake.adb.setCommandError(
      "input stylus tap",
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );
    const result = await fake.tapAt.execute(stylusTap());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Do not retry automatically");
  });

  test("an interrupted long press says how long the press may stay held", async () => {
    const fake = androidWithSdk(34);
    fake.adb.setCommandError(
      "input stylus swipe",
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );
    const result = await fake.tapAt.execute(stylusTap({ action: "longPress", durationMs: 800 }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("press may still be held on the device for up to 800 ms");
    expect(result.error).toContain("Do not retry automatically");
  });

  test("an interrupted plain tap carries no hold warning", async () => {
    const fake = androidWithSdk(34);
    fake.adb.setCommandError(
      "input stylus tap",
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );
    const result = await fake.tapAt.execute(stylusTap());

    expect(result.error).not.toContain("still be held");
  });

  test("a command the device rejected is a plain failure, safe to retry", async () => {
    const fake = androidWithSdk(34);
    fake.adb.setCommandResponse("input stylus tap", {
      stdout: "",
      stderr: "Error: unknown source",
    } as never);
    const result = await fake.tapAt.execute(stylusTap());

    expect(result.success).toBe(false);
    expect(result.error).not.toContain("indeterminate");
  });

  test("a failing stylus command reports the failure instead of falling back to a finger", async () => {
    const fake = androidWithSdk(34);
    fake.adb.setCommandResponse("input stylus tap", {
      stdout: "",
      stderr: "Error: unknown source",
    } as never);
    const result = await fake.tapAt.execute(stylusTap());

    expect(result.success).toBe(false);
    expect(fake.androidDispatches).toEqual([]);
  });

  test("a display change while the SDK is read refuses the tap before any stylus command", async () => {
    let sdkRead = false;
    const fake = createTapAt(ANDROID, 10, 10, undefined, () => (sdkRead ? 2 : 1));
    fake.adb.setAndroidApiLevel(34);
    const read = fake.adb.getAndroidApiLevel.bind(fake.adb);
    fake.adb.getAndroidApiLevel = async (...args) => {
      sdkRead = true;
      return read(...args);
    };

    const result = await fake.tapAt.execute(stylusTap());

    expect(result.success).toBe(false);
    expect(fake.adb.getExecutedCommands().some((c) => c.includes("stylus"))).toBe(false);
    expect(fake.androidDispatches).toEqual([]);
  });
});
