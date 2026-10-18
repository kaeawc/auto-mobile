import { describe, expect, test } from "bun:test";
import {
  STYLUS_INPUT_MIN_SDK,
  checkStylusPointer,
  stylusInputCommand,
} from "../../../src/features/action/stylusPointer";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const stylus = { toolType: "stylus" as const };

function adbWithSdk(level: number | null): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  adb.setAndroidApiLevel(level);
  return adb;
}

describe("stylus pointer capability (#13081)", () => {
  test("the minimum SDK is Android 12, the first release that sets the tool type from the source", () => {
    expect(STYLUS_INPUT_MIN_SDK).toBe(31);
  });

  test("the command uses the stylus source with no display flag", () => {
    expect(stylusInputCommand("tap 1 2")).toBe("shell input stylus tap 1 2");
  });

  test("a supported stylus request on API 31 passes", async () => {
    const refusal = await checkStylusPointer(adbWithSdk(31), {
      pointer: stylus,
      platform: "android",
      gesture: "tap",
    });
    expect(refusal).toBeUndefined();
  });

  test("pressure 1.0 is accepted, as the shell injects it", async () => {
    const refusal = await checkStylusPointer(adbWithSdk(34), {
      pointer: { ...stylus, pressure: 1 },
      platform: "android",
      gesture: "swipe",
    });
    expect(refusal).toBeUndefined();
  });

  test.each([0, 0.5, 0.99])("pressure %p is refused, never rounded to 1.0", async (pressure) => {
    const adb = adbWithSdk(34);
    const refusal = await checkStylusPointer(adb, {
      pointer: { ...stylus, pressure },
      platform: "android",
      gesture: "tap",
    });
    expect(refusal).toContain("pressure 1.0");
    expect(refusal).toContain(String(pressure));
    // Refused before any device read.
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("iOS is refused as Android-only", async () => {
    const refusal = await checkStylusPointer(adbWithSdk(34), {
      pointer: stylus,
      platform: "ios",
      gesture: "tap",
    });
    expect(refusal).toContain("Android-only");
  });

  test("doubleTap is refused until two shell invocations are shown to hold the interval", async () => {
    const refusal = await checkStylusPointer(adbWithSdk(34), {
      pointer: stylus,
      platform: "android",
      gesture: "doubleTap",
    });
    expect(refusal).toContain("doubleTap");
  });

  test("a panel selection is refused until display routing is verified", async () => {
    const refusal = await checkStylusPointer(adbWithSdk(34), {
      pointer: stylus,
      platform: "android",
      gesture: "swipe",
      display: "cover",
    });
    expect(refusal).toContain("display");
  });

  test("API 30 is refused: the shell builds the event without a tool type there", async () => {
    const refusal = await checkStylusPointer(adbWithSdk(30), {
      pointer: stylus,
      platform: "android",
      gesture: "tap",
    });
    expect(refusal).toContain("API 31");
    expect(refusal).toContain("30");
  });

  test("an unreadable SDK fails closed", async () => {
    const refusal = await checkStylusPointer(adbWithSdk(null), {
      pointer: stylus,
      platform: "android",
      gesture: "tap",
    });
    expect(refusal).toContain("could not read");
  });

  test("a request without a pointer is untouched", async () => {
    const adb = adbWithSdk(null);
    expect(
      await checkStylusPointer(adb, { pointer: undefined, platform: "ios", gesture: "tap" }),
    ).toBeUndefined();
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});
