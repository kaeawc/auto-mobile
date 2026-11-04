import type { BootedDevice } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
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
const credentialPresenceArgs = [...LOCK_SETTINGS, "get-disabled"];

async function hasCredential(adb: AdbExecutor, signal?: AbortSignal): Promise<boolean> {
  const result = await shell(adb, credentialPresenceArgs, signal);
  // Observed Android 14 outputs: get-disabled is true without a credential and false with one.
  if (result === "true") {
    return false;
  }
  if (result === "false") {
    return true;
  }
  throw new Error(`Unexpected lock_settings get-disabled result: ${result}`);
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

  const reset = async (signal?: AbortSignal): Promise<void> =>
    serialize(async () => {
      if (ownsPin && (await testPinVerifies(adb, signal))) {
        await shell(adb, clearPinArgs, signal);
        if (await hasCredential(adb, signal)) {
          throw new Error(
            "Clearing the AutoMobile test PIN did not remove the lock-screen credential",
          );
        }
      }
      ownsPin = false;
      return;
    });

  const applyNow = async (
    value: string,
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> => {
    if (value !== "pin" && value !== "none") {
      rejectValue(LOCK_SCREEN_FAULT_KEY, value, ["pin", "none"]);
    }
    const verifies = await testPinVerifies(adb, signal);
    const present = await hasCredential(adb, signal);
    if (value === "pin") {
      if (verifies) {
        ownsPin = true;
        return { status: "unchanged", detail: "AutoMobile test PIN is already set", reset };
      }
      if (present) {
        unsupported(
          "the lock screen is set to a credential AutoMobile does not know; clear it first",
        );
      }
      ownsPin = true;
      try {
        await shell(adb, setPinArgs, signal);
      } catch (error) {
        throw new OwedResetError(
          "Setting the AutoMobile test PIN failed; release will verify and restore the lock screen.",
          reset,
          { cause: error },
        );
      }
      if (!(await testPinVerifies(adb, signal))) {
        throw new Error("Could not verify the AutoMobile test PIN after setting it");
      }
      return { status: "applied", detail: "Set the AutoMobile test PIN", reset };
    }
    if (verifies) {
      await shell(adb, clearPinArgs, signal);
      if (await hasCredential(adb, signal)) {
        throw new Error(
          "Clearing the AutoMobile test PIN did not remove the lock-screen credential",
        );
      }
      ownsPin = false;
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
