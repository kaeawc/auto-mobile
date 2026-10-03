import type {
  AndroidHingeAngleConsole,
  AndroidHingeAngleConsoleResult,
  AndroidHingeAngleReadbackResult,
} from "../../src/features/device/AndroidHingeAngleConsole";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";

export class FakeAndroidHingeAngleConsole implements AndroidHingeAngleConsole {
  readonly calls: { degrees: number; signal?: AbortSignal }[] = [];
  result: AndroidHingeAngleConsoleResult = { ok: true };
  error?: Error;
  readBackResult?: AndroidHingeAngleReadbackResult;
  readBackError?: Error;
  readonly readBackCalls: { signal?: AbortSignal }[] = [];

  async getHingeAngle(
    _adb: ReturnType<AdbClientFactory["create"]>,
    options: { signal?: AbortSignal } = {},
  ): Promise<AndroidHingeAngleReadbackResult> {
    this.readBackCalls.push({ signal: options.signal });
    if (this.readBackError) {
      throw this.readBackError;
    }
    return this.readBackResult ?? { ok: true, degrees: this.calls.at(-1)!.degrees };
  }
  async setHingeAngle(
    _adb: ReturnType<AdbClientFactory["create"]>,
    degrees: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<AndroidHingeAngleConsoleResult> {
    this.calls.push({ degrees, signal: options.signal });
    if (this.error) {
      throw this.error;
    }
    return this.result;
  }
}
