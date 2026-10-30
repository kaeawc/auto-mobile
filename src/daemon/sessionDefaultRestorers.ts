import type { BootedDevice } from "../models";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import { Rotate } from "../features/action/Rotate";
import { restoreScreenReaderState } from "../features/accessibility/ScreenReaderRestore";
import { invalidateDisplayCaches } from "../features/observe/DisplayTransition";
import { AndroidDeviceClockAdapter, restoreDeviceClock } from "../features/utility/DeviceClock";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { KeepScreenAwakeManager } from "../utils/KeepScreenAwakeManager";
import { DeviceState } from "../features/utility/DeviceState";
import type { Timer } from "../utils/SystemTimer";
import type {
  BiometricEnrollmentRestorer,
  ClockRestorer,
  KeepScreenAwakeRestorer,
  NetworkConditionRestorer,
  RotationRestorer,
  ScreenReaderRestorer,
} from "./sessionManager";

/**
 * Production wiring for the per-session device-state restorers SessionManager runs on release.
 * Tests inject fakes through SessionManagerOptions instead; these are the defaults (#11796).
 */
export function defaultKeepScreenAwakeRestorer(device: BootedDevice): KeepScreenAwakeRestorer {
  return new KeepScreenAwakeManager(device, defaultAdbClientFactory, (target) =>
    AndroidCtrlProxyClient.getInstance(target),
  );
}

/** Simulator enrollment is session-scoped state, so lifecycle tests never invoke simctl. */
export function defaultBiometricEnrollmentRestorer(
  device: BootedDevice,
): BiometricEnrollmentRestorer {
  return {
    restore: async (enrollment) => {
      const result = await new DeviceState(device).setBiometricEnrollmentState(enrollment);
      if (!result.supported || result.error || result.verified === false) {
        throw new Error(result.error ?? "Failed to restore iOS Simulator biometric enrollment");
      }
    },
  };
}

/** Device-wide network conditioning is session-scoped state (#6012); restores normal connectivity. */
export function defaultNetworkConditionRestorer(device: BootedDevice): NetworkConditionRestorer {
  return {
    restore: async (profile) => {
      const result = await new DeviceState(device).setState({ networkCondition: { profile } });
      if (!result.success) {
        throw new Error(
          result.networkCondition?.error ?? result.error ?? "Failed to restore network condition",
        );
      }
    },
  };
}

export function defaultClockRestorerFactory(timer: Timer): (device: BootedDevice) => ClockRestorer {
  return (device) => ({
    restore: async (value, signal) => {
      const adapter = new AndroidDeviceClockAdapter(defaultAdbClientFactory.create(device), signal);
      const root = await adapter.ensureRoot();
      if (!root.success) {
        throw new Error(root.error);
      }
      value.rootedByUs ||= root.rootedByUs;
      const result = await restoreDeviceClock(device, adapter, value, {
        hostClock: timer,
        invalidate: (deviceId) => {
          if (!signal?.aborted) {
            invalidateDisplayCaches(deviceId, "Device clock restored");
          }
        },
      });
      if (!result.verified) {
        throw new Error(result.error ?? "Clock restoration did not verify");
      }
    },
  });
}

export function defaultRotationRestorerFactory(
  timer: Timer,
): (device: BootedDevice) => RotationRestorer {
  return (device) => ({
    restore: (state, signal) =>
      new Rotate(device, { adb: null, timer }).restoreRotationSettings(state, signal),
  });
}

/** The real TalkBack/VoiceOver restorer. */
export function defaultScreenReaderRestorer(device: BootedDevice): ScreenReaderRestorer {
  return { restore: (state, signal) => restoreScreenReaderState(device, state, signal) };
}
