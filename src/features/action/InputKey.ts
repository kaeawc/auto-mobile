import { errorMessage } from "../../utils/describeUnknownError";
import type { BootedDevice } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { ANDROID_KEYCOMBINATION_MIN_API_LEVEL } from "./asciiKeyEvents";

export const SUPPORTED_INPUT_KEYS = [
  "enter",
  "tab",
  "escape",
  "backspace",
  "delete",
  "arrow_up",
  "arrow_down",
  "arrow_left",
  "arrow_right",
] as const;

export type InputKeyName = (typeof SUPPORTED_INPUT_KEYS)[number];

export const INPUT_KEY_CODE_MAP = {
  enter: "KEYCODE_ENTER",
  tab: "KEYCODE_TAB",
  escape: "KEYCODE_ESCAPE",
  backspace: "KEYCODE_DEL",
  delete: "KEYCODE_FORWARD_DEL",
  arrow_up: "KEYCODE_DPAD_UP",
  arrow_down: "KEYCODE_DPAD_DOWN",
  arrow_left: "KEYCODE_DPAD_LEFT",
  arrow_right: "KEYCODE_DPAD_RIGHT",
} as const satisfies Record<InputKeyName, string>;

export const INPUT_KEY_MODIFIERS = ["shift", "ctrl", "alt", "meta"] as const;
export type InputKeyModifier = (typeof INPUT_KEY_MODIFIERS)[number];

const INPUT_KEY_MODIFIER_CODE_MAP: Record<InputKeyModifier, string> = {
  shift: "KEYCODE_SHIFT_LEFT",
  ctrl: "KEYCODE_CTRL_LEFT",
  alt: "KEYCODE_ALT_LEFT",
  meta: "KEYCODE_META_LEFT",
};

export const INPUT_KEY_IOS_UNSUPPORTED_ERROR =
  "input/key is unsupported on ios; CtrlProxy does not expose discrete key events";

export function isInputKeyName(key: string): key is InputKeyName {
  return (SUPPORTED_INPUT_KEYS as readonly string[]).includes(key);
}

export interface InputKeyResult {
  success: boolean;
  key: InputKeyName;
  keyCode: string;
  error?: string;
}

export interface FrameContextValidator {
  validateFrameContext(
    frameContext: string,
    timeoutMs?: number,
  ): Promise<{ success: boolean; error?: string }>;
}

export interface InputKeyIosClient {
  requestPressKey(
    key: InputKeyName,
    modifiers: InputKeyModifier[],
    timeoutMs?: number,
  ): Promise<{ success: boolean; error?: string }>;
}

export type InputKeyIosClientFactory = (device: BootedDevice) => InputKeyIosClient;

const defaultInputKeyIosClientFactory: InputKeyIosClientFactory = (device) =>
  IOSCtrlProxyClient.getInstance(device);

export class InputKey {
  private readonly device: BootedDevice;
  private readonly adb: AdbExecutor;

  constructor(
    device: BootedDevice,
    private readonly adbFactory: AdbClientFactory = defaultAdbClientFactory,
    private readonly frameContextValidator?: FrameContextValidator,
    private readonly timer: Timer = defaultTimer,
    private readonly iosClientFactory: InputKeyIosClientFactory = defaultInputKeyIosClientFactory,
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
  }

  async press(
    key: InputKeyName,
    timeoutMs?: number,
    frameContext?: string,
    modifiers: readonly InputKeyModifier[] = [],
  ): Promise<InputKeyResult> {
    if (this.device.platform === "ios") {
      return this.pressIos(key, modifiers, timeoutMs);
    }
    return this.pressAndroid(key, modifiers, timeoutMs, frameContext);
  }

  private async pressAndroid(
    key: InputKeyName,
    modifiers: readonly InputKeyModifier[],
    timeoutMs?: number,
    frameContext?: string,
  ): Promise<InputKeyResult> {
    const keyCode = INPUT_KEY_CODE_MAP[key];
    try {
      const deadlineMs = timeoutMs !== undefined ? this.timer.now() + timeoutMs : undefined;
      const uniqueModifiers = [...new Set(modifiers)];
      const inputArgsResult = await this.resolveAndroidInputArgs(
        key,
        keyCode,
        uniqueModifiers,
        deadlineMs,
      );
      if ("failure" in inputArgsResult) {
        return inputArgsResult.failure;
      }
      const adbTimeoutMs = this.remainingMs(deadlineMs);
      if (adbTimeoutMs !== undefined && adbTimeoutMs <= 0) {
        return {
          success: false,
          key,
          keyCode,
          error: "input/key deadline exhausted before ADB keyevent",
        };
      }
      let validationFailure: InputKeyResult | undefined;
      try {
        await this.adb.execute(inputArgsResult.args, {
          timeoutMs: adbTimeoutMs,
          noRetry: true,
          beforeDispatch:
            frameContext === undefined
              ? undefined
              : async () => {
                  validationFailure = await this.validateBeforeDispatch(
                    key,
                    keyCode,
                    frameContext,
                    deadlineMs,
                  );
                  if (validationFailure) {
                    throw new Error(validationFailure.error);
                  }
                },
        });
      } catch (error) {
        if (validationFailure) {
          return validationFailure;
        }
        throw error;
      }
      return {
        success: true,
        key,
        keyCode,
      };
    } catch (error) {
      const message = errorMessage(error);
      logger.warn(`input/key failed for ${key}: ${message}`, error);
      return {
        success: false,
        key,
        keyCode,
        error: `Failed to press key "${key}": ${message}`,
      };
    }
  }

  private async resolveAndroidInputArgs(
    key: InputKeyName,
    keyCode: string,
    modifiers: InputKeyModifier[],
    deadlineMs?: number,
  ): Promise<{ args: string[] } | { failure: InputKeyResult }> {
    if (modifiers.length === 0) {
      return { args: ["shell", "input", "keyevent", keyCode] };
    }

    const apiLevel = await readAndroidDeviceApiLevel(
      this.adb,
      this.remainingMs(deadlineMs),
      this.timer,
    );
    if (apiLevel === null || apiLevel < ANDROID_KEYCOMBINATION_MIN_API_LEVEL) {
      return {
        failure: {
          success: false,
          key,
          keyCode,
          error:
            `Key modifiers require Android API ${ANDROID_KEYCOMBINATION_MIN_API_LEVEL}+ ` +
            "for input keycombination",
        },
      };
    }
    return {
      args: [
        "shell",
        "input",
        "keycombination",
        ...modifiers.map((modifier) => INPUT_KEY_MODIFIER_CODE_MAP[modifier]),
        keyCode,
      ],
    };
  }

  private async validateBeforeDispatch(
    key: InputKeyName,
    keyCode: string,
    frameContext: string,
    deadlineMs?: number,
  ): Promise<InputKeyResult | undefined> {
    const validationFailure = await this.validateFrameContext(
      key,
      keyCode,
      frameContext,
      deadlineMs,
    );
    if (validationFailure) {
      return validationFailure;
    }
    const remainingMs = this.remainingMs(deadlineMs);
    if (remainingMs !== undefined && remainingMs <= 0) {
      return {
        success: false,
        key,
        keyCode,
        error: "input/key deadline exhausted before ADB keyevent",
      };
    }
    return undefined;
  }

  private async pressIos(
    key: InputKeyName,
    modifiers: readonly InputKeyModifier[],
    timeoutMs?: number,
  ): Promise<InputKeyResult> {
    try {
      const result = await this.iosClientFactory(this.device).requestPressKey(
        key,
        [...new Set(modifiers)],
        timeoutMs,
      );
      return {
        success: result.success,
        key,
        keyCode: key,
        ...(result.error ? { error: result.error } : {}),
      };
    } catch (error) {
      const message = errorMessage(error);
      logger.warn(`iOS input/key failed for ${key}: ${message}`, error);
      return {
        success: false,
        key,
        keyCode: key,
        error: `Failed to press key "${key}" on iOS: ${message}`,
      };
    }
  }

  private async validateFrameContext(
    key: InputKeyName,
    keyCode: string,
    frameContext: string | undefined,
    deadlineMs: number | undefined,
  ): Promise<InputKeyResult | undefined> {
    if (frameContext === undefined) {
      return undefined;
    }
    const validationTimeoutMs = this.remainingMs(deadlineMs);
    if (validationTimeoutMs !== undefined && validationTimeoutMs <= 0) {
      return {
        success: false,
        key,
        keyCode,
        error: "input/key deadline exhausted before frame context validation",
      };
    }
    const validator =
      this.frameContextValidator ??
      AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
    const validation = await validator.validateFrameContext(frameContext, validationTimeoutMs);
    if (validation.success) {
      return undefined;
    }
    return {
      success: false,
      key,
      keyCode,
      error:
        validation.error ??
        "Frame context is stale or unavailable; observe a fresh frame before retrying",
    };
  }

  private remainingMs(deadlineMs: number | undefined): number | undefined {
    return deadlineMs === undefined ? undefined : deadlineMs - this.timer.now();
  }
}
