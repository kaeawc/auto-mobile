import type { BootedDevice } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "./DeviceConditionController";
import type { DeviceConditionKey } from "./DeviceConditionTypes";
import {
  AdbFingerprintEnrollmentPort,
  type FingerprintEnrollmentPort,
} from "./fingerprintEnrollmentPort";
import { createSerializer, rejectValue, unsupported } from "./injectorSupport";
import { OwedResetError } from "./OwedResetError";

export const BIOMETRIC_ENROLLMENT_FAULT_KEY = "faults.biometricEnrollment";

/** Android allows at most five fingerprints per user. */
export const MAX_FINGERPRINT_ENROLLMENTS = 5;

const VALUES = ["add", "none"] as const;

/**
 * `faults.biometricEnrollment` (#17299, spec #16866): add a fingerprint on an Android emulator,
 * which permanently invalidates keys created with `setInvalidatedByBiometricEnrollment(true)`,
 * or remove every fingerprint.
 *
 * Settings will not enroll without a lock screen, and no shell command removes one fingerprint.
 * So the injector starts only from a device with no lock screen, sets the AutoMobile test PIN
 * itself, and restores by clearing that PIN: Android deletes every fingerprint with the
 * credential, which returns the device to no lock screen and no fingerprints.
 */
export function createBiometricEnrollmentInjector(
  port: FingerprintEnrollmentPort,
): DeviceConditionInjector {
  const serialize = createSerializer();
  let ownsPin = false;
  // Bumped when this injector sets or clears its PIN, so a reset from an earlier installation is
  // a no-op once a later one exists (the controller holds one reset per successful add).
  let generation = 0;

  const ownedStatePresent = async (signal?: AbortSignal): Promise<boolean> =>
    ownsPin && (await port.testPinVerifies(signal));

  const clearOwned = async (signal?: AbortSignal): Promise<void> => {
    if (await port.testPinVerifies(signal)) {
      await port.clearTestPin(signal);
    }
    if (await port.hasCredential(signal)) {
      throw new Error(
        "Clearing the AutoMobile test PIN did not remove the lock-screen credential; fingerprints may remain enrolled",
      );
    }
    const remaining = await port.enrolledCount(signal);
    if (remaining > 0) {
      throw new Error(
        `${remaining} fingerprint(s) are still enrolled after clearing the AutoMobile test PIN`,
      );
    }
    ownsPin = false;
    generation += 1;
  };

  const resetFor =
    (installed: number) =>
    (signal?: AbortSignal): Promise<void> =>
      serialize(async () => {
        if (installed === generation && ownsPin) {
          await clearOwned(signal);
        }
      });

  const isCleanFor =
    (installed: number) =>
    async (signal?: AbortSignal): Promise<boolean> =>
      installed !== generation || !(await ownedStatePresent(signal));

  const refuseUnlessEmulatorConsole = async (signal?: AbortSignal): Promise<void> => {
    if (!(await port.isEmulator(signal))) {
      unsupported(
        "faults.biometricEnrollment needs an Android emulator; a physical device has no emulator console to touch its fingerprint sensor",
      );
    }
    if (!(await port.consoleSupportsFinger(signal))) {
      unsupported(
        "the emulator console is unavailable or does not accept `finger` commands (`adb emu help` lists no finger); restart the emulator with its console enabled",
      );
    }
  };

  /** Set the test PIN from a device with no lock screen; returns the new installation. */
  const takeLockScreen = async (count: number, signal?: AbortSignal): Promise<number> => {
    if ((await port.hasCredential(signal)) || count > 0) {
      unsupported(
        "the device already has a lock screen or enrolled fingerprints that AutoMobile did not set, and it could not restore them; " +
          "start from no lock screen (reset faults.lockScreen, or remove the credential in Settings)",
      );
    }
    ownsPin = true;
    generation += 1;
    const installed = generation;
    try {
      await port.setTestPin(signal);
    } catch (error) {
      throw new OwedResetError(
        "Setting the AutoMobile test PIN failed; release will verify and restore the lock screen.",
        resetFor(installed),
        { cause: error, isClean: isCleanFor(installed) },
      );
    }
    return installed;
  };

  const add = async (signal?: AbortSignal): Promise<DeviceConditionApplyOutcome> => {
    await refuseUnlessEmulatorConsole(signal);
    const before = await port.enrolledCount(signal);
    if (before >= MAX_FINGERPRINT_ENROLLMENTS) {
      unsupported(
        `${before} fingerprints are enrolled, and Android allows at most ${MAX_FINGERPRINT_ENROLLMENTS}`,
      );
    }
    const installed = ownsPin ? generation : await takeLockScreen(before, signal);
    const reset = resetFor(installed);
    const isClean = isCleanFor(installed);
    // Settings refuses a finger id that is already enrolled, so each add touches a new one.
    const fingerId = before + 1;
    try {
      await port.enrollFingerprint(fingerId, before + 1, signal);
    } catch (error) {
      throw new OwedResetError(
        "Enrolling a fingerprint through Settings failed; release will clear the AutoMobile test PIN and every fingerprint.",
        reset,
        { cause: error, isClean },
      );
    }
    return {
      status: "applied",
      detail: `Enrolled a fingerprint with emulator finger id ${fingerId}; ${before + 1} enrolled`,
      reset,
      isClean,
    };
  };

  const remove = async (signal?: AbortSignal): Promise<DeviceConditionApplyOutcome> => {
    if (ownsPin) {
      await clearOwned(signal);
      return {
        status: "applied",
        detail: "Removed every fingerprint by clearing the AutoMobile test PIN",
      };
    }
    if ((await port.enrolledCount(signal)) === 0) {
      return { status: "unchanged", detail: "No fingerprint is enrolled" };
    }
    unsupported(
      "the enrolled fingerprints were not added by faults.biometricEnrollment; remove them in Settings",
    );
  };

  return {
    key: BIOMETRIC_ENROLLMENT_FAULT_KEY,
    apply: (value, signal) =>
      serialize(() => {
        if (value === "add") {
          return add(signal);
        }
        if (value === "none") {
          return remove(signal);
        }
        rejectValue(BIOMETRIC_ENROLLMENT_FAULT_KEY, value, VALUES);
      }),
    isClean: async (signal) => !(await ownedStatePresent(signal)),
  };
}

export interface BiometricEnrollmentInjectorDeps {
  adbFactory?: AdbClientFactory;
  /** Builds the device seam; tests inject a fake. */
  portFactory?: (device: BootedDevice) => FingerprintEnrollmentPort;
  cache?: Map<string, DeviceConditionInjector>;
}

const injectorsByDevice = new Map<string, DeviceConditionInjector>();

export function resolveBiometricEnrollmentInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: BiometricEnrollmentInjectorDeps = {},
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || key !== BIOMETRIC_ENROLLMENT_FAULT_KEY) {
    return undefined;
  }
  const cache = deps.cache ?? injectorsByDevice;
  let injector = cache.get(device.deviceId);
  if (!injector) {
    const port =
      deps.portFactory?.(device) ??
      new AdbFingerprintEnrollmentPort(
        (deps.adbFactory ?? defaultAdbClientFactory).create(device),
        device.deviceId,
      );
    injector = createBiometricEnrollmentInjector(port);
    cache.set(device.deviceId, injector);
  }
  return injector;
}
