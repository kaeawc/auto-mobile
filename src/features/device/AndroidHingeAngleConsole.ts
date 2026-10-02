import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { emulatorConsoleReportsFailure } from "../utility/DeviceState";

export type AndroidHingeAngleConsoleResult = { ok: true } | { ok: false; reason: string };

/** Best effort: this sensor command's syntax has not been captured on a real AVD. */
export interface AndroidHingeAngleConsole {
  setHingeAngle(
    adb: ReturnType<AdbClientFactory["create"]>,
    degrees: number,
    options?: { signal?: AbortSignal },
  ): Promise<AndroidHingeAngleConsoleResult>;
}

export class AdbAndroidHingeAngleConsole implements AndroidHingeAngleConsole {
  async setHingeAngle(
    adb: ReturnType<AdbClientFactory["create"]>,
    degrees: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<AndroidHingeAngleConsoleResult> {
    const { stdout, stderr } = await adb.executeCommand(
      `emu sensor set hinge-angle0 ${degrees}`,
      undefined,
      undefined,
      true,
      options.signal,
    );
    if (emulatorConsoleReportsFailure(stdout, stderr)) {
      // Preserve the first non-empty line verbatim; this is no sensor-output parser.
      const reason = `${stdout}\n${stderr}`.split(/\r?\n/).find((line) => line.trim().length > 0)!;
      return { ok: false, reason };
    }
    return { ok: true };
  }
}
