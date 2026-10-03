import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { emulatorConsoleReportsFailure } from "../utility/DeviceState";

export type AndroidHingeAngleConsoleResult = { ok: true } | { ok: false; reason: string };

export type AndroidHingeAngleReadbackResult =
  | { ok: true; degrees: number }
  | { ok: false; reason: string };

/** Parse only the captured single-line sensor format; never infer an angle. */
export function parseEmulatorHingeAngleReadback(stdout: string): AndroidHingeAngleReadbackResult {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    return { ok: false, reason: "Expected exactly one non-empty hinge-angle0 read-back line" };
  }
  const match = /^hinge-angle0 = (-?\d+(?:\.\d+)?)$/.exec(lines[0]);
  if (!match) {
    return { ok: false, reason: `Unrecognized hinge-angle0 read-back: ${lines[0]}` };
  }
  const degrees = Number(match[1]);
  return Number.isFinite(degrees)
    ? { ok: true, degrees }
    : { ok: false, reason: "Hinge-angle0 read-back is not a finite number" };
}

/** Best effort: console acceptance alone does not confirm the resulting angle. */
export interface AndroidHingeAngleConsole {
  getHingeAngle(
    adb: ReturnType<AdbClientFactory["create"]>,
    options?: { signal?: AbortSignal },
  ): Promise<AndroidHingeAngleReadbackResult>;
  setHingeAngle(
    adb: ReturnType<AdbClientFactory["create"]>,
    degrees: number,
    options?: { signal?: AbortSignal },
  ): Promise<AndroidHingeAngleConsoleResult>;
}

export class AdbAndroidHingeAngleConsole implements AndroidHingeAngleConsole {
  async getHingeAngle(
    adb: ReturnType<AdbClientFactory["create"]>,
    options: { signal?: AbortSignal } = {},
  ): Promise<AndroidHingeAngleReadbackResult> {
    const { stdout, stderr } = await adb.executeCommand(
      "emu sensor get hinge-angle0",
      undefined,
      undefined,
      true,
      options.signal,
    );
    if (emulatorConsoleReportsFailure(stdout, stderr)) {
      const reason = `${stdout}\n${stderr}`.split(/\r?\n/).find((line) => line.trim().length > 0)!;
      return { ok: false, reason };
    }
    return parseEmulatorHingeAngleReadback(stdout);
  }

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
