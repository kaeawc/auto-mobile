import { ActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  defaultDeviceTraits,
  type DeviceTraits,
} from "../../utils/android-cmdline-tools/deviceTraits";
import {
  emulatorConsoleFailureReason,
  emulatorConsoleReportsFailure,
} from "../../utils/android-cmdline-tools/emulatorConsoleReply";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { enrollFingerprintThroughSettings } from "./fingerprintSettingsEnrollment";
import { shell } from "./injectorSupport";
import {
  clearTestPin,
  hasCredential,
  LOCK_SCREEN_TEST_PIN,
  setTestPin,
  testPinVerifies,
} from "./lockScreenFaultInjectors";

/**
 * What `faults.biometricEnrollment` needs from an Android device (#17299). The injector holds
 * the ownership and restore rules; this seam holds every adb, console and Settings call, so
 * the rules are tested against a fake.
 */
export interface FingerprintEnrollmentPort {
  /** True only for a confirmed emulator (`ro.kernel.qemu`). */
  isEmulator(signal?: AbortSignal): Promise<boolean>;
  /** Whether the emulator console answers and accepts `finger` commands. */
  consoleSupportsFinger(signal?: AbortSignal): Promise<boolean>;
  /** Fingerprints enrolled for user 0, from `dumpsys fingerprint`. */
  enrolledCount(signal?: AbortSignal): Promise<number>;
  hasCredential(signal?: AbortSignal): Promise<boolean>;
  testPinVerifies(signal?: AbortSignal): Promise<boolean>;
  setTestPin(signal?: AbortSignal): Promise<void>;
  /** Clears the test PIN; Android deletes every enrolled fingerprint with it. */
  clearTestPin(signal?: AbortSignal): Promise<void>;
  /** Enroll one more fingerprint touched with `fingerId`, until `targetCount` are enrolled. */
  enrollFingerprint(fingerId: number, targetCount: number, signal?: AbortSignal): Promise<void>;
}

/** The user `dumpsys fingerprint` is read for; the lock_settings commands also act on it. */
const ENROLLMENT_USER_ID = 0;

const SENSOR_LIFT_DELAY_MS = 250;

interface FingerprintDumpUser {
  id: number;
  count: number;
}

function isDumpUser(entry: unknown, userId: number): entry is FingerprintDumpUser {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "id" in entry &&
    entry.id === userId &&
    "count" in entry &&
    typeof entry.count === "number"
  );
}

/**
 * The enrolled count for `userId` from `dumpsys fingerprint`, which prints one JSON object per
 * sensor with a `prints` array of `{ id: <userId>, count, ... }`. Undefined when no sensor
 * reports the user. Exported for tests.
 */
export function parseFingerprintEnrollmentCount(
  dump: string,
  userId: number = ENROLLMENT_USER_ID,
): number | undefined {
  const counts = dump
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.includes('"prints"'))
    .flatMap((line) => {
      try {
        const parsed: { prints?: unknown } = JSON.parse(line);
        const prints: unknown[] = Array.isArray(parsed.prints) ? parsed.prints : [];
        return prints.filter((entry) => isDumpUser(entry, userId));
      } catch (error) {
        // A line that only looks like the JSON dump is not one; other lines may still be.
        logger.debug(
          `[biometricEnrollment] skipped unparsable dumpsys line: ${errorMessage(error)}`,
        );
        return [];
      }
    })
    .map((entry) => entry.count);
  return counts.length > 0 ? Math.max(...counts) : undefined;
}

async function consoleCommand(
  adb: AdbExecutor,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await adb.execute(["emu", ...args], { signal });
  if (result.error || emulatorConsoleReportsFailure(result.stdout, result.stderr)) {
    throw new ActionableError(
      `adb emu ${args.join(" ")} failed: ${result.error ?? emulatorConsoleFailureReason(result.stdout, result.stderr)}`,
    );
  }
  return result.stdout;
}

export interface AdbFingerprintEnrollmentPortDeps {
  traits?: DeviceTraits;
  timer?: Timer;
}

export class AdbFingerprintEnrollmentPort implements FingerprintEnrollmentPort {
  private readonly traits: DeviceTraits;
  private readonly timer: Timer;

  constructor(
    private readonly adb: AdbExecutor,
    private readonly deviceId: string,
    deps: AdbFingerprintEnrollmentPortDeps = {},
  ) {
    this.traits = deps.traits ?? defaultDeviceTraits;
    this.timer = deps.timer ?? defaultTimer;
  }

  async isEmulator(): Promise<boolean> {
    return (await this.traits.read(this.adb, this.deviceId)).isEmulator === true;
  }

  async consoleSupportsFinger(signal?: AbortSignal): Promise<boolean> {
    try {
      return (await consoleCommand(this.adb, ["help"], signal)).includes("finger");
    } catch (error) {
      // An unreachable console is the answer this probe exists to give; the caller refuses.
      logger.debug(`[biometricEnrollment] emulator console probe failed: ${errorMessage(error)}`);
      return false;
    }
  }

  async enrolledCount(signal?: AbortSignal): Promise<number> {
    const dump = await shell(this.adb, ["dumpsys", "fingerprint"], signal);
    const count = parseFingerprintEnrollmentCount(dump);
    if (count === undefined) {
      throw new ActionableError(
        "Could not read the enrolled fingerprint count from `dumpsys fingerprint`; this image may have no fingerprint sensor.",
      );
    }
    return count;
  }

  hasCredential(): Promise<boolean> {
    return hasCredential(this.adb);
  }

  testPinVerifies(signal?: AbortSignal): Promise<boolean> {
    return testPinVerifies(this.adb, signal);
  }

  setTestPin(signal?: AbortSignal): Promise<void> {
    return setTestPin(this.adb, signal);
  }

  clearTestPin(signal?: AbortSignal): Promise<void> {
    return clearTestPin(this.adb, signal);
  }

  enrollFingerprint(fingerId: number, targetCount: number, signal?: AbortSignal): Promise<void> {
    return enrollFingerprintThroughSettings(
      {
        adb: this.adb,
        timer: this.timer,
        deviceId: this.deviceId,
        pin: LOCK_SCREEN_TEST_PIN,
        enrolledCount: (s) => this.enrolledCount(s),
        touchSensor: async (id, s) => {
          await consoleCommand(this.adb, ["finger", "touch", String(id)], s);
          await this.timer.sleep(SENSOR_LIFT_DELAY_MS);
          await consoleCommand(this.adb, ["finger", "remove"], s);
        },
      },
      fingerId,
      targetCount,
      signal,
    );
  }
}
