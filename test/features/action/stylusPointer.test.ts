import { pointerNeedsInstrumentation } from "../../../src/models/PointerOption";
import { describe, expect, test } from "bun:test";
import {
  STYLUS_INPUT_MIN_SDK,
  StylusOutcomeIndeterminateError,
  checkStylusPointer,
  classifyStylusFailure,
  dispatchStylusTap,
  stylusInputCommand,
  stylusRefusal,
} from "../../../src/features/action/stylusPointer";
import { StaleDisplayError } from "../../../src/features/observe/StaleDisplayError";
import { InputCommandRejectedError } from "../../../src/features/action/touchscreenInput";
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

  test.each([0, 0.5, 0.99])(
    "pressure %p is not a static refusal; it takes the instrumentation route (#13099)",
    async (pressure) => {
      const adb = adbWithSdk(34);
      const request = {
        pointer: { ...stylus, pressure },
        platform: "android",
        gesture: "tap" as const,
      };
      expect(stylusRefusal(request)).toBeUndefined();
      expect(pointerNeedsInstrumentation(request.pointer)).toBe(true);
      // The shell route's API check does not apply to the instrumentation route.
      expect(await checkStylusPointer(adb, request)).toBeUndefined();
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );

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

  test("a tool type other than a stylus or eraser is refused rather than injected as one", async () => {
    const adb = adbWithSdk(34);
    const refusal = await checkStylusPointer(adb, {
      pointer: { toolType: "finger" } as never,
      platform: "android",
      gesture: "tap",
    });
    expect(refusal).toContain("finger");
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("an eraser skips the adb input check: only the pointer routes can inject it (#13105)", async () => {
    const adb = adbWithSdk(null);
    const refusal = await checkStylusPointer(adb, {
      pointer: { toolType: "eraser" },
      platform: "android",
      gesture: "tap",
    });
    expect(refusal).toBeUndefined();
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("an eraser is Android-only", async () => {
    const refusal = await checkStylusPointer(adbWithSdk(34), {
      pointer: { toolType: "eraser" },
      platform: "ios",
      gesture: "tap",
    });
    expect(refusal).toContain('"eraser" is Android-only');
  });

  test("a request without a pointer is untouched", async () => {
    const adb = adbWithSdk(null);
    expect(
      await checkStylusPointer(adb, { pointer: undefined, platform: "ios", gesture: "tap" }),
    ).toBeUndefined();
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});

describe("stylus tap dispatch fence (#13081)", () => {
  test("a changed display refuses the tap before any command is spawned", async () => {
    const adb = adbWithSdk(34);
    const stale = new Error("display changed");

    await expect(
      dispatchStylusTap(
        adb,
        { x: 1, y: 2 },
        { action: "tap" },
        {
          assertCurrent: () => {
            throw stale;
          },
        },
      ),
    ).rejects.toBe(stale);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("a current display lets the tap through the fence", async () => {
    const adb = adbWithSdk(34);
    let checked = 0;

    await dispatchStylusTap(
      adb,
      { x: 1, y: 2 },
      { action: "tap" },
      { assertCurrent: () => void checked++ },
    );
    expect(checked).toBe(1);
    expect(adb.getExecutedCommands()).toEqual(["shell input stylus tap 1 2"]);
  });
});

describe("classifyStylusFailure (#13081)", () => {
  const command = "shell input stylus tap 1 2";
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  const refusal = Object.assign(new Error("Command failed"), {
    cause: Object.assign(new Error("exit 255"), { stderr: "Error: Unknown source\n" }),
  });

  test("a stale display and an already-classified refusal pass through unchanged", () => {
    const stale = new StaleDisplayError({
      observedGeneration: 1,
      currentGeneration: 2,
      retry: "observe",
    });
    const rejected = new InputCommandRejectedError("refused");

    expect(classifyStylusFailure(stale, { command, dispatched: true })).toBe(stale);
    expect(classifyStylusFailure(rejected, { command, dispatched: true })).toBe(rejected);
  });

  test("a refusal in a rejected adb call is retry-safe, even after the send began", () => {
    const result = classifyStylusFailure(refusal, { command, dispatched: true });

    expect(result).toBeInstanceOf(InputCommandRejectedError);
    expect(result).not.toBeInstanceOf(StylusOutcomeIndeterminateError);
  });

  test("a failure before the command was sent passes through", () => {
    expect(classifyStylusFailure(abort, { command, dispatched: false })).toBe(abort);
  });

  test("any other failure after the send is indeterminate", () => {
    const result = classifyStylusFailure(new Error("adb connection lost"), {
      command,
      dispatched: true,
    });

    expect(result).toBeInstanceOf(StylusOutcomeIndeterminateError);
  });

  test("an interrupted long press names the hold window; an interrupted tap does not", () => {
    const held = classifyStylusFailure(abort, { command, dispatched: true, holdMs: 800 });
    const tap = classifyStylusFailure(abort, { command, dispatched: true });

    expect((held as Error).message).toContain("still be held on the device for up to 800 ms");
    expect((tap as Error).message).not.toContain("still be held");
  });
});
