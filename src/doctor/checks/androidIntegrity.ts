import type { BootedDevice } from "../../models";
import {
  readIntegritySignals,
  type IntegritySignalReading,
} from "../../features/deviceCondition/integritySignals";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { remainingDoctorProbe } from "../deadline";
import type { CheckResult, DoctorProbeOptions } from "../types";

/** The slice of the adb factory this check drives; fakes implement just these methods. */
export interface IntegrityAdbFactory {
  create(device?: BootedDevice): Pick<AdbExecutor, "getBootedAndroidDevices" | "execute">;
}

const describeFamily = (readings: IntegritySignalReading[], family: string): string => {
  const active = readings.filter((r) => r.family === family && r.active);
  const total = readings.filter((r) => r.family === family).length;
  if (active.length === 0) {
    return `${family}: none of ${total} signals present`;
  }
  const names = active.map((r) => `${r.id}${r.mutability === "image-fixed" ? "*" : ""}`).join(", ");
  return `${family}: ${active.length}/${total} present (${names})`;
};

/**
 * Report which root and emulator detection signals each booted Android device
 * presents (#14062). Informational: it never fails, because an emulator showing
 * emulator signals is normal. `*` marks image-fixed signals no fixture can hide.
 */
export async function checkAndroidIntegritySignals(
  adbFactory: IntegrityAdbFactory = defaultAdbClientFactory,
  probe: DoctorProbeOptions = {},
): Promise<CheckResult> {
  try {
    const currentProbe = remainingDoctorProbe(probe);
    const devices = await adbFactory.create().getBootedAndroidDevices({
      signal: currentProbe.signal,
      timeoutMs: currentProbe.timeoutMs,
    });
    if (devices.length === 0) {
      return {
        name: "Android Integrity Signals",
        status: "pass",
        message: "No Android devices connected; nothing to probe",
      };
    }
    const lines: string[] = [];
    for (const device of devices) {
      const readings = await readIntegritySignals(
        adbFactory.create(device),
        remainingDoctorProbe(probe).signal,
      );
      lines.push(
        `${device.deviceId} — ${describeFamily(readings, "root")}; ${describeFamily(readings, "emulator")}`,
      );
    }
    return {
      name: "Android Integrity Signals",
      status: "pass",
      // No `value`: the console formatter prints `value` instead of `message`, which would hide the signals.
      message: `${lines.join(" | ")} (* = image-fixed, cannot be hidden)`,
    };
  } catch (error) {
    logger.warn(`Android integrity signal check failed: ${errorMessage(error)}`, error);
    return {
      name: "Android Integrity Signals",
      status: "warn",
      message: `Could not read integrity signals: ${errorMessage(error)}`,
    };
  }
}
