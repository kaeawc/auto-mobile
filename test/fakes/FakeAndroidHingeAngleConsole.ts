import type {
  AndroidHingeAngleConsole,
  AndroidHingeAngleConsoleResult,
} from "../../src/features/device/AndroidHingeAngleConsole";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";

export class FakeAndroidHingeAngleConsole implements AndroidHingeAngleConsole {
  readonly calls: { degrees: number; signal?: AbortSignal }[] = [];
  result: AndroidHingeAngleConsoleResult = { ok: true };
  error?: Error;
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
