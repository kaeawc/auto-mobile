import type { BootedDevice, PressButtonResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  defaultDeviceTraits,
  isAutomotive,
  type DeviceTraits,
} from "../../utils/android-cmdline-tools/deviceTraits";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { throwIfAborted } from "../../utils/toolUtils";

/**
 * Rotary controller input for Android Automotive (#14920), reached through `pressButton`.
 *
 * Nudges and select are the keys AAOS maps a rotary controller's nudge and press to:
 * `KEYCODE_SYSTEM_NAVIGATION_*` (280..283) and `KEYCODE_DPAD_CENTER` (23). Rotation goes through
 * the car service's `inject-rotary` command; its flags are unverified until the AAOS spike
 * (#14916) runs on an emulator, so a reply that looks like a failure is reported, not assumed ok.
 *
 * Watch crown scrolling (#14902) and car rotary focus are different interactions and share no
 * model here.
 */

export const MAX_ROTARY_STEPS = 50;

type RotaryAction =
  | { kind: "rotate"; clockwise: boolean }
  | { kind: "key"; keyCode: number; label: string };

/** Rotary buttons `pressButton` accepts, in the order its schema lists them. */
export const ROTARY_BUTTONS = [
  "rotary_rotate_cw",
  "rotary_rotate_ccw",
  "rotary_nudge_up",
  "rotary_nudge_down",
  "rotary_nudge_left",
  "rotary_nudge_right",
  "rotary_select",
] as const;
export type RotaryButton = (typeof ROTARY_BUTTONS)[number];

const ROTARY_ACTIONS: Readonly<Record<RotaryButton, RotaryAction>> = {
  rotary_rotate_cw: { kind: "rotate", clockwise: true },
  rotary_rotate_ccw: { kind: "rotate", clockwise: false },
  rotary_nudge_up: { kind: "key", keyCode: 280, label: "nudge up" },
  rotary_nudge_down: { kind: "key", keyCode: 281, label: "nudge down" },
  rotary_nudge_left: { kind: "key", keyCode: 282, label: "nudge left" },
  rotary_nudge_right: { kind: "key", keyCode: 283, label: "nudge right" },
  rotary_select: { kind: "key", keyCode: 23, label: "select" },
};

export function isRotaryButton(button: unknown): button is RotaryButton {
  return typeof button === "string" && (ROTARY_BUTTONS as readonly string[]).includes(button);
}

/** The adb shell arguments one rotary press runs. Pure, so each action's command is testable. */
export function rotaryCommand(button: RotaryButton, steps: number): string[] {
  const action = ROTARY_ACTIONS[button];
  if (action.kind === "key") {
    return ["input", "keyevent", String(action.keyCode)];
  }
  // One boolean per detent: `-c true,true,true` is three clockwise steps.
  return [
    "cmd",
    "car_service",
    "inject-rotary",
    "-c",
    Array.from({ length: steps }, () => String(action.clockwise)).join(","),
  ];
}

/** Steps apply to rotation only; the key actions are single events. */
export function validateRotarySteps(button: RotaryButton, steps: number | undefined): number {
  if (steps === undefined) {
    return 1;
  }
  if (ROTARY_ACTIONS[button].kind !== "rotate") {
    throw new ActionableError(
      `steps applies to rotary_rotate_cw and rotary_rotate_ccw only; ${button} is a single event.`,
    );
  }
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_ROTARY_STEPS) {
    throw new ActionableError(
      `steps must be a whole number from 1 to ${MAX_ROTARY_STEPS}; got ${steps}.`,
    );
  }
  return steps;
}

const COMMAND_FAILURE = /\b(unknown command|exception|error)\b/i;

export class RotaryInput {
  constructor(
    private readonly device: BootedDevice,
    private readonly adb: AdbExecutor,
    private readonly traits: DeviceTraits = defaultDeviceTraits,
  ) {}

  async press(
    button: RotaryButton,
    steps: number | undefined,
    signal?: AbortSignal,
  ): Promise<PressButtonResult> {
    throwIfAborted(signal);
    const count = validateRotarySteps(button, steps);
    await this.assertAutomotive();
    const result = await this.adb.execute(["shell", ...rotaryCommand(button, count)], {
      noRetry: true,
      signal: combineWithAmbientAbort(signal),
    });
    const action = ROTARY_ACTIONS[button];
    const keyCode = action.kind === "key" ? action.keyCode : -1;
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.error || COMMAND_FAILURE.test(output)) {
      return {
        success: false,
        button,
        keyCode,
        error: `Rotary ${button} failed: ${result.error ?? output.split("\n")[0]}`,
      };
    }
    return { success: true, button, keyCode };
  }

  private async assertAutomotive(): Promise<void> {
    const traits = await this.traits.read(this.adb, this.device.deviceId);
    if (!isAutomotive(traits)) {
      throw new ActionableError(
        `Rotary input needs an Android Automotive device; ${this.device.deviceId} is not one.`,
      );
    }
  }
}
