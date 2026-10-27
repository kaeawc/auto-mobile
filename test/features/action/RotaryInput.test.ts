import { describe, expect, test } from "bun:test";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeTimer } from "../../fakes/FakeTimer";
import { buildObserveResult } from "../../helpers/observeFixture";
import { createExecResult } from "../../../src/utils/execResult";
import type { BootedDevice } from "../../../src/models";
import type { DeviceTraits } from "../../../src/utils/android-cmdline-tools/deviceTraits";
import {
  ROTARY_BUTTONS,
  RotaryInput,
  isRotaryButton,
  rotaryCommand,
  validateRotarySteps,
} from "../../../src/features/action/RotaryInput";
import { PressButton } from "../../../src/features/action/PressButton";
import { pressButtonInput } from "../../../src/server/interactionTools/deviceSchemas";

const device: BootedDevice = { name: "AAOS", platform: "android", deviceId: "emulator-5554" };

function traitsOf(formFactor: "automotive" | null): DeviceTraits {
  return {
    read: () =>
      Promise.resolve({
        isEmulator: true,
        model: null,
        sdk: 34,
        abi: null,
        manufacturer: null,
        brand: null,
        skin: null,
        formFactor,
      }),
  };
}

describe("rotary commands (#14920)", () => {
  test.each([
    ["rotary_nudge_up", ["input", "keyevent", "280"]],
    ["rotary_nudge_down", ["input", "keyevent", "281"]],
    ["rotary_nudge_left", ["input", "keyevent", "282"]],
    ["rotary_nudge_right", ["input", "keyevent", "283"]],
    ["rotary_select", ["input", "keyevent", "23"]],
    ["rotary_rotate_cw", ["cmd", "car_service", "inject-rotary", "-c", "true"]],
  ] as const)("%s builds its command", (button, expected) => {
    expect(rotaryCommand(button, 1)).toEqual([...expected]);
  });

  test("rotation repeats one detent per step in the requested direction", () => {
    expect(rotaryCommand("rotary_rotate_ccw", 3).at(-1)).toBe("false,false,false");
    expect(rotaryCommand("rotary_rotate_cw", 2).at(-1)).toBe("true,true");
  });

  test("steps validate: rotation only, whole numbers in range", () => {
    expect(validateRotarySteps("rotary_rotate_cw", undefined)).toBe(1);
    expect(validateRotarySteps("rotary_rotate_cw", 50)).toBe(50);
    expect(() => validateRotarySteps("rotary_rotate_cw", 0)).toThrow(/1 to 50/);
    expect(() => validateRotarySteps("rotary_rotate_cw", 51)).toThrow(/1 to 50/);
    expect(() => validateRotarySteps("rotary_rotate_cw", 1.5)).toThrow(/whole number/);
    expect(() => validateRotarySteps("rotary_select", 2)).toThrow(/rotation|rotary_rotate/);
  });

  test("every schema rotary button is recognized, and ordinary buttons are not", () => {
    for (const button of ROTARY_BUTTONS) {
      expect(isRotaryButton(button)).toBe(true);
      expect(pressButtonInput.safeParse({ button }).success).toBe(true);
    }
    expect(isRotaryButton("home")).toBe(false);
    expect(pressButtonInput.safeParse({ button: "rotary_rotate_cw", steps: 0 }).success).toBe(
      false,
    );
  });
});

describe("RotaryInput", () => {
  test("runs the command on an automotive device", async () => {
    const adb = new FakeAdbExecutor();
    const result = await new RotaryInput(device, adb, traitsOf("automotive")).press(
      "rotary_rotate_cw",
      3,
    );
    expect(result).toMatchObject({ success: true, button: "rotary_rotate_cw" });
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd car_service inject-rotary -c true,true,true",
    ]);
  });

  test("a phone is refused with no command", async () => {
    const adb = new FakeAdbExecutor();
    await expect(
      new RotaryInput(device, adb, traitsOf(null)).press("rotary_select", undefined),
    ).rejects.toThrow(/Android Automotive/);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("a rejected command is reported, not assumed ok", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("inject-rotary", createExecResult("Unknown command: inject-rotary", ""));
    const result = await new RotaryInput(device, adb, traitsOf("automotive")).press(
      "rotary_rotate_cw",
      1,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown command");
  });

  test("pressButton routes a rotary button and its steps through execute", async () => {
    const adb = new FakeAdbExecutor();
    const window = new FakeWindow();
    window.configureCachedActiveWindow(null);
    window.configureActiveWindow({
      appId: "com.android.car.settings",
      activityName: "A",
      layoutSeqSum: 1,
    });
    const observe = new FakeObserveScreen();
    observe.setObserveResult(
      buildObserveResult({
        updatedAt: 1,
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: { packageName: "com.android.car.settings", hierarchy: { node: {} } },
      }),
    );
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const action = new PressButton(device, adb, timer, undefined, undefined, {
      window,
      observeScreen: observe,
      awaitIdle: new FakeAwaitIdle(),
      deviceTraits: traitsOf("automotive"),
    });
    const result = await action.execute("rotary_rotate_ccw", { steps: 2 });
    expect(result.success).toBe(true);
    expect(adb.wasCommandExecuted("inject-rotary -c false,false")).toBe(true);
  });
});
