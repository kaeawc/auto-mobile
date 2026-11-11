import { toActionableError } from "../../models/ActionableError";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";

export const GLASSES_GESTURES = ["tap", "swipeForward", "swipeBack"] as const;
export const GLASSES_AXES = ["vertical", "horizontal"] as const;
export type GlassesGesture = (typeof GLASSES_GESTURES)[number];
export type GlassesAxis = (typeof GLASSES_AXES)[number];
export const GLASSES_MAX_COUNT = 20;

/** DPAD equivalents observed by the focused glasses app; no touchpad motion injection. */
export const GLASSES_KEY_CODES = {
  vertical: {
    tap: "KEYCODE_DPAD_CENTER",
    swipeForward: "KEYCODE_DPAD_DOWN",
    swipeBack: "KEYCODE_DPAD_UP",
  },
  horizontal: {
    tap: "KEYCODE_DPAD_CENTER",
    swipeForward: "KEYCODE_DPAD_RIGHT",
    swipeBack: "KEYCODE_DPAD_LEFT",
  },
} as const;

export interface GlassesInputRequest {
  gesture: GlassesGesture;
  axis?: GlassesAxis;
  count?: number;
  signal?: AbortSignal;
}

export interface GlassesInputResult {
  success: boolean;
  message: string;
  gesture: GlassesGesture;
  axis: GlassesAxis;
  count: number;
  /** Commands attempted, including a failed command; remaining repetitions are not sent. */
  keyCodes: string[];
  commands: string[];
}

export interface GlassesInputInjector {
  inject(request: GlassesInputRequest): Promise<GlassesInputResult>;
}

const COMMAND_FAILED =
  /^(?:Error|Exception|KO)\b|Invalid command|Unknown command|No shell command|Unknown source/m;

export class AdbGlassesInputInjector implements GlassesInputInjector {
  constructor(private readonly adb: AdbCommandRunner) {}

  async inject(request: GlassesInputRequest): Promise<GlassesInputResult> {
    const { gesture, axis = "vertical", count = 1, signal } = request;
    const keyCode = GLASSES_KEY_CODES[axis][gesture];
    const commands: string[] = [];
    const keyCodes: string[] = [];
    const base = { gesture, axis, count, keyCodes, commands };
    for (let i = 0; i < count; i++) {
      signal?.throwIfAborted();
      const command = `shell input keyevent ${keyCode}`;
      commands.push(command);
      keyCodes.push(keyCode);
      try {
        const result = await this.adb.executeCommand(command, {
          timeoutMs: 10_000,
          noRetry: true,
          signal,
        });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (COMMAND_FAILED.test(output)) {
          return {
            ...base,
            success: false,
            message: `Glasses input failed on repetition ${i + 1}: ${output.slice(0, 200)}`,
          };
        }
      } catch (error) {
        signal?.throwIfAborted();
        throw toActionableError(
          error,
          `Failed to run adb ${command} (repetition ${i + 1} of ${count})`,
        );
      }
    }
    return {
      ...base,
      success: true,
      message: `Sent ${count} ${gesture} input(s). No read-back was performed; observe afterwards to verify the effect.`,
    };
  }
}
