import type { BootedDevice } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AdbLockSettingsClient } from "../utility/screenLock/AndroidLockSettings";
import { errorMessage } from "../../utils/describeUnknownError";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "./DeviceConditionController";
import type { DeviceConditionKey } from "./DeviceConditionTypes";
import { createSerializer, rejectValue, shell, unsupported } from "./injectorSupport";
import { OwedResetError } from "./OwedResetError";

export const LOCK_SCREEN_FAULT_KEY = "faults.lockScreen";
export const LOCK_SCREEN_TEST_PIN = "1234";

// Provisional Android lock_settings commands; keep device-specific syntax here for easy adjustment.
const LOCK_SETTINGS = ["cmd", "lock_settings"] as const;
const setPinArgs = [...LOCK_SETTINGS, "set-pin", LOCK_SCREEN_TEST_PIN];
const clearPinArgs = [...LOCK_SETTINGS, "clear", "--old", LOCK_SCREEN_TEST_PIN];
const verifyPinArgs = [...LOCK_SETTINGS, "verify", "--old", LOCK_SCREEN_TEST_PIN];

// `locksettings get-disabled` only reports a fully disabled lock screen, so a swipe-only device
// would look credentialed; the dumpsys credential type is the source of truth.
async function hasCredential(adb: AdbExecutor): Promise<boolean> {
  const reading = await new AdbLockSettingsClient(adb).read();
  if (reading.secure !== undefined) {
    return reading.secure;
  }
  throw new Error(
    reading.error ?? "Could not determine whether the lock screen has a credential set",
  );
}

async function testPinVerifies(adb: AdbExecutor, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await shell(adb, verifyPinArgs, signal);
    return result.includes("verified successfully");
  } catch (error) {
    if (errorMessage(error).includes("exit code: 255")) {
      return false;
    }
    throw error;
  }
}

export function createLockScreenFaultInjector(adb: AdbExecutor): DeviceConditionInjector {
  const serialize = createSerializer();
  let ownsPin = false;
  // Bumped on every install and clear, so a reset from an earlier installation cannot remove a
  // PIN that a later caller installed.
  let generation = 0;

  const resetFor =
    (installed: number) =>
    async (signal?: AbortSignal): Promise<void> =>
      serialize(async () => {
        if (installed !== generation) {
          return;
        }
        if (ownsPin && (await testPinVerifies(adb, signal))) {
          await shell(adb, clearPinArgs, signal);
          if (await hasCredential(adb)) {
            throw new Error(
              "Clearing the AutoMobile test PIN did not remove the lock-screen credential",
            );
          }
        }
        ownsPin = false;
        generation += 1;
      });

  const applyNow = async (
    value: string,
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> => {
    if (value !== "pin" && value !== "none") {
      rejectValue(LOCK_SCREEN_FAULT_KEY, value, ["pin", "none"]);
    }
    const verifies = await testPinVerifies(adb, signal);
    const present = await hasCredential(adb);
    if (value === "pin") {
      if (verifies) {
        // The cleanup obligation stays with whichever caller installed the PIN.
        return { status: "unchanged", detail: "AutoMobile test PIN is already set" };
      }
      if (present) {
        unsupported(
          "the lock screen is set to a credential AutoMobile does not know; clear it first",
        );
      }
      ownsPin = true;
      generation += 1;
      const reset = resetFor(generation);
      try {
        await shell(adb, setPinArgs, signal);
      } catch (error) {
        throw new OwedResetError(
          "Setting the AutoMobile test PIN failed; release will verify and restore the lock screen.",
          reset,
          { cause: error },
        );
      }
      try {
        if (!(await testPinVerifies(adb, signal))) {
          throw new Error("Could not verify the AutoMobile test PIN after setting it");
        }
      } catch (error) {
        // The PIN is installed even though verification failed or timed out; keep the reset owed.
        throw new OwedResetError(
          "Verifying the AutoMobile test PIN failed; release will verify and restore the lock screen.",
          reset,
          { cause: error },
        );
      }
      return { status: "applied", detail: "Set the AutoMobile test PIN", reset };
    }
    if (verifies) {
      await shell(adb, clearPinArgs, signal);
      if (await hasCredential(adb)) {
        throw new Error(
          "Clearing the AutoMobile test PIN did not remove the lock-screen credential",
        );
      }
      ownsPin = false;
      generation += 1;
      return { status: "applied", detail: "Cleared the AutoMobile test PIN" };
    }
    if (!present) {
      return { status: "unchanged", detail: "No lock-screen credential is set" };
    }
    unsupported("the lock screen is set to a credential AutoMobile does not know; clear it first");
  };

  return {
    key: LOCK_SCREEN_FAULT_KEY,
    apply: (value, signal) => serialize(() => applyNow(value, signal)),
    isClean: async (signal) => !(ownsPin && (await testPinVerifies(adb, signal))),
  };
}

export interface LockScreenFaultInjectorDeps {
  adbFactory?: AdbClientFactory;
  cache?: Map<string, DeviceConditionInjector>;
}

const injectorsByDevice = new Map<string, DeviceConditionInjector>();

export function resolveLockScreenFaultInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: LockScreenFaultInjectorDeps = {},
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || key !== LOCK_SCREEN_FAULT_KEY) {
    return undefined;
  }
  const cache = deps.cache ?? injectorsByDevice;
  let injector = cache.get(device.deviceId);
  if (!injector) {
    injector = createLockScreenFaultInjector(
      (deps.adbFactory ?? defaultAdbClientFactory).create(device),
    );
    cache.set(device.deviceId, injector);
  }
  return injector;
}
