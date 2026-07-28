import type { BootedDevice } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { AndroidCtrlProxyClient } from "../observe/android";

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
} as const;

export type InputKeyName = keyof typeof INPUT_KEY_CODE_MAP;

export const SUPPORTED_INPUT_KEYS = Object.keys(INPUT_KEY_CODE_MAP) as readonly InputKeyName[];

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
    timeoutMs?: number
  ): Promise<{ success: boolean; error?: string }>;
}

export class InputKey {
  private readonly device: BootedDevice;
  private readonly adb: AdbExecutor;

  constructor(
    device: BootedDevice,
    private readonly adbFactory: AdbClientFactory = defaultAdbClientFactory,
    private readonly frameContextValidator?: FrameContextValidator
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
  }

  async press(
    key: InputKeyName,
    timeoutMs?: number,
    frameContext?: string
  ): Promise<InputKeyResult> {
    if (this.device.platform !== "android") {
      return {
        success: false,
        key,
        keyCode: "",
        error: INPUT_KEY_IOS_UNSUPPORTED_ERROR,
      };
    }

    const keyCode = INPUT_KEY_CODE_MAP[key];
    try {
      if (frameContext !== undefined) {
        const validator = this.frameContextValidator ??
          AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
        const validation = await validator.validateFrameContext(frameContext, timeoutMs);
        if (!validation.success) {
          return {
            success: false,
            key,
            keyCode,
            error: validation.error ?? "Frame context is stale or unavailable; observe a fresh frame before retrying",
          };
        }
      }
      await this.adb.executeCommand(`shell input keyevent ${keyCode}`, timeoutMs, undefined, true);
      return {
        success: true,
        key,
        keyCode,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`input/key failed for ${key}: ${message}`, error);
      return {
        success: false,
        key,
        keyCode,
        error: `Failed to press key "${key}": ${message}`,
      };
    }
  }
}
