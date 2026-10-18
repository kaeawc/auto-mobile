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
});
