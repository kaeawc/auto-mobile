import { errorMessage } from "../../utils/describeUnknownError";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice, ExecResult } from "../../models";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { isIosSimulatorDevice } from "../action/IosSimulatorPermissions";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import {
  IOS_NOTIFYUTIL_REGISTERED_SET_TIMEOUT_MS,
  iosNotifyutilGetCommand,
  iosNotifyutilRegisteredSetReadPostCommand,
  parseNotifyutilState,
} from "../../utils/ios-cmdline-tools/notifyutil";

export type DoNotDisturbMode = "off" | "none" | "priority" | "alarms";

/**
 * Machine-readable description of how faithfully a platform can apply a
 * requested Do Not Disturb mode:
 * - `full`: every mode (`off`/`none`/`priority`/`alarms`) is distinct, persisted
 *   and verifiable (Android via `zen_mode`).
 * - `binary`: only on/off is available; `priority`/`alarms` cannot be honored as
 *   distinct tiers (iOS simulator via the `com.apple.donotdisturb.enabled`
 *   Darwin notification — there is no public per-mode Focus API).
 * - `unsupported`: DND cannot be set at all (physical iOS device — iOS exposes no
 *   public API to enable/disable Focus or Do Not Disturb).
 */
export type DoNotDisturbCapability = "full" | "binary" | "unsupported";

export interface DoNotDisturbState {
  supported: boolean;
  enabled?: boolean;
  mode?: DoNotDisturbMode;
  rawValue?: string;
  method?: "android_settings_zen_mode" | "android_cmd_notification" | "ios_simulator_notifyutil";
  bestEffort?: boolean;
  verified?: boolean;
  warning?: string;
  error?: string;
  /** How faithfully the platform can apply the requested mode. */
  capability?: DoNotDisturbCapability;
  /** What the caller asked for (set on writes). */
  requestedMode?: DoNotDisturbMode;
  /** What the platform could actually apply (set on writes). */
  appliedMode?: DoNotDisturbMode;
}

export type BiometricEnrollment = "enrolled" | "not_enrolled";

export interface BiometricEnrollmentState {
  supported: boolean;
  enrollment?: BiometricEnrollment;
  method?: "ios_simulator_notifyutil";
  verified?: boolean;
  error?: string;
}

export interface DeviceStateResult {
  success: boolean;
  deviceId: string;
  platform: "android" | "ios";
  doNotDisturb?: DoNotDisturbState;
  biometrics?: BiometricEnrollmentState;
  error?: string;
}

export interface SetDeviceStateInput {
  doNotDisturb?: {
    enabled?: boolean;
    mode?: DoNotDisturbMode;
  };
  biometrics?: {
    enrollment: BiometricEnrollment;
  };
}

interface IosSimulatorClient {
  executeCommand(command: string, timeoutMs?: number): Promise<ExecResult>;
}

export interface DeviceStateDependencies {
  adbFactory?: AdbClientFactory;
  simctl?: IosSimulatorClient | null;
  timer?: Timer;
}

const IOS_BIOMETRIC_ENROLLMENT_NOTIFICATION = "com.apple.BiometricKit.enrollmentChanged";
const IOS_BIOMETRICS_UNSUPPORTED_ERROR =
  "Biometric enrollment state can only be read or set on an iOS Simulator.";

/**
 * Physical iOS devices expose no public API to enable/disable Focus or Do Not
 * Disturb. The only sanctioned app-side hook is the read-only Focus Filter API
 * (apps react to an active Focus, they cannot set one), and Apple's device
 * tooling (devicectl, XCUITest) ships no DND/Focus setter. Simulators are no
 * better off (see IOS_SIM_DND_UNSUPPORTED_ERROR) — DND automation is
 * unavailable on iOS entirely — but the two carry distinct errors so callers
 * can tell a device limitation from a daemon-owned key.
 */
const IOS_PHYSICAL_DND_UNSUPPORTED_ERROR =
  "Do Not Disturb cannot be set on a physical iOS device: iOS exposes no public API to " +
  "enable/disable Focus or Do Not Disturb (only the read-only Focus Filter API), and Apple's " +
  "device tooling (devicectl, XCUITest) ships no DND/Focus setter. Trigger DND manually or via a " +
  "Shortcuts automation on device.";

/**
 * Do Not Disturb is unsupported on **every** iOS simulator runtime, not just
 * iOS 18+. DND/Focus is owned by the private `com.apple.donotdisturbd` daemon,
 * which shipped with Focus in iOS 15 and reclaims the legacy
 * `com.apple.donotdisturb.enabled` Darwin notification: a value posted with the
 * `notifyutil -1 -s -g -p` shape reads back as `0` from a fresh process, while
 * an unmanaged notify key (BiometricKit's) set the very same way persists as
 * `1`. So the legacy key neither reflects nor controls real Focus state — a
 * write is an unverifiable no-op and a read is a confident falsehood.
 *
 * Empirically verified (issue #2862) on booted simulators, `donotdisturbd`
 * running in each: **iOS 16.4 (20E247)** and **iOS 17.5 (21F79)** both revert
 * the key while the control key persists, matching the previously-recorded
 * iOS 18.x and 26.x behavior. iOS 15 could not be tested because Xcode 26.3
 * offers no iOS 15 simulator runtime for download — which also means no iOS 15
 * simulator can be created with current tooling, so the old `<= 17` legacy
 * fast-path was unreachable in practice as well as wrong.
 */
const IOS_SIM_DND_UNSUPPORTED_ERROR =
  "Do Not Disturb cannot be read or set on an iOS simulator: Do Not Disturb is owned by the " +
  "private donotdisturbd Focus daemon, which holds the state in its own store and resets the " +
  "legacy com.apple.donotdisturb.enabled notification — so that notification neither reflects " +
  "nor controls the real Focus state. iOS exposes no public API to read or set Focus / Do Not " +
  "Disturb. Set it manually in the simulator, or via a Shortcuts automation.";

function parseAndroidZenMode(raw: string): DoNotDisturbState {
  const value = raw.trim();
  switch (value) {
    case "0":
      return {
        supported: true,
        capability: "full",
        enabled: false,
        mode: "off",
        rawValue: value,
        method: "android_settings_zen_mode",
      };
    case "1":
      return {
        supported: true,
        capability: "full",
        enabled: true,
        mode: "priority",
        rawValue: value,
        method: "android_settings_zen_mode",
      };
    case "2":
      return {
        supported: true,
        capability: "full",
        enabled: true,
        mode: "none",
        rawValue: value,
        method: "android_settings_zen_mode",
      };
    case "3":
      return {
        supported: true,
        capability: "full",
        enabled: true,
        mode: "alarms",
        rawValue: value,
        method: "android_settings_zen_mode",
      };
    default:
      return {
        supported: true,
        capability: "full",
        rawValue: value,
        method: "android_settings_zen_mode",
        warning: `Unknown Android zen_mode value: ${value}`,
      };
  }
}

function modeForInput(input: SetDeviceStateInput["doNotDisturb"]): DoNotDisturbMode {
  if (input?.mode) {
    return input.mode;
  }
  return input?.enabled === false ? "off" : "none";
}

export const EMPTY_STATE_SELECTION_ERROR = "At least one device state field must be included";

function doNotDisturbInputError(input: SetDeviceStateInput["doNotDisturb"]): string | undefined {
  if (!input || input.enabled === undefined || input.mode === undefined) {
    return undefined;
  }
  if ((input.enabled === false) !== (input.mode === "off")) {
    return `doNotDisturb.enabled=${input.enabled} conflicts with doNotDisturb.mode="${input.mode}"`;
  }
  return undefined;
}

export class DeviceState {
  private device: BootedDevice;

  private adbFactory: AdbClientFactory;

  private simctl: IosSimulatorClient | null;

  private timer: Timer;

  constructor(device: BootedDevice, dependencies: DeviceStateDependencies = {}) {
    this.device = device;
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.simctl = dependencies.simctl ?? null;
    this.timer = dependencies.timer ?? defaultTimer;
  }

  async getState(
    include: ("doNotDisturb" | "biometrics")[] = ["doNotDisturb"],
  ): Promise<DeviceStateResult> {
    // An empty selection would otherwise read nothing and report success.
    if (include.length === 0) {
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        error: EMPTY_STATE_SELECTION_ERROR,
      };
    }
    const doNotDisturb = include.includes("doNotDisturb")
      ? this.device.platform === "android"
        ? await this.getAndroidDoNotDisturb()
        : await this.getIosDoNotDisturb()
      : undefined;
    const biometrics = include.includes("biometrics")
      ? await this.getBiometricEnrollmentState()
      : undefined;
    const requestedStates = [doNotDisturb, biometrics].filter(
      (state): state is DoNotDisturbState | BiometricEnrollmentState => state !== undefined,
    );
    const error = requestedStates.find((state) => state.error)?.error;

    return {
      success: requestedStates.every((state) => state.supported && !state.error),
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      ...(doNotDisturb ? { doNotDisturb } : {}),
      ...(biometrics ? { biometrics } : {}),
      ...(error ? { error } : {}),
    };
  }

  async setState(input: SetDeviceStateInput): Promise<DeviceStateResult> {
    if (!input.doNotDisturb && !input.biometrics) {
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        error: "At least one device state field must be provided",
      };
    }

    const inputError = doNotDisturbInputError(input.doNotDisturb);
    if (inputError) {
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        error: inputError,
      };
    }

    const doNotDisturb = input.doNotDisturb
      ? this.device.platform === "android"
        ? await this.setAndroidDoNotDisturb(input.doNotDisturb)
        : await this.setIosDoNotDisturb(input.doNotDisturb)
      : undefined;
    const biometrics = input.biometrics
      ? await this.setBiometricEnrollmentState(input.biometrics.enrollment)
      : undefined;
    const requestedStates = [doNotDisturb, biometrics].filter(
      (state): state is DoNotDisturbState | BiometricEnrollmentState => state !== undefined,
    );
    const error = requestedStates.find((state) => state.error)?.error;

    return {
      success: requestedStates.every(
        (state) => state.supported && !state.error && state.verified !== false,
      ),
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      ...(doNotDisturb ? { doNotDisturb } : {}),
      ...(biometrics ? { biometrics } : {}),
      ...(error ? { error } : {}),
    };
  }

  async getBiometricEnrollmentState(): Promise<BiometricEnrollmentState> {
    if (this.device.platform !== "ios" || !isIosSimulatorDevice(this.device)) {
      return { supported: false, error: IOS_BIOMETRICS_UNSUPPORTED_ERROR };
    }
    const simctl = this.simctl ?? new SimCtlClient(this.device);
    try {
      const result = await simctl.executeCommand(
        iosNotifyutilGetCommand(this.device.deviceId, IOS_BIOMETRIC_ENROLLMENT_NOTIFICATION),
      );
      const stderr = result.stderr?.trim();
      if (stderr) {
        return {
          supported: true,
          method: "ios_simulator_notifyutil",
          error: `notifyutil failed: ${stderr}`,
        };
      }
      const enrolled = parseNotifyutilState(result.stdout ?? "");
      if (enrolled === null) {
        return {
          supported: true,
          method: "ios_simulator_notifyutil",
          error: "Could not parse iOS Simulator biometric enrollment state from notifyutil.",
        };
      }
      return {
        supported: true,
        enrollment: enrolled ? "enrolled" : "not_enrolled",
        method: "ios_simulator_notifyutil",
        verified: true,
      };
    } catch (error) {
      return {
        supported: true,
        method: "ios_simulator_notifyutil",
        error: errorMessage(error),
      };
    }
  }

  async setBiometricEnrollmentState(
    enrollment: BiometricEnrollment,
  ): Promise<BiometricEnrollmentState> {
    if (this.device.platform !== "ios" || !isIosSimulatorDevice(this.device)) {
      return {
        supported: false,
        enrollment,
        verified: false,
        error: IOS_BIOMETRICS_UNSUPPORTED_ERROR,
      };
    }
    const simctl = this.simctl ?? new SimCtlClient(this.device);
    try {
      const result = await simctl.executeCommand(
        iosNotifyutilRegisteredSetReadPostCommand(
          this.device.deviceId,
          IOS_BIOMETRIC_ENROLLMENT_NOTIFICATION,
          enrollment === "enrolled" ? "1" : "0",
        ),
        IOS_NOTIFYUTIL_REGISTERED_SET_TIMEOUT_MS,
      );
      const stderr = result.stderr?.trim();
      if (stderr) {
        return {
          supported: true,
          enrollment,
          method: "ios_simulator_notifyutil",
          verified: false,
          error: `notifyutil failed: ${stderr}`,
        };
      }
      const enrolled = parseNotifyutilState(result.stdout ?? "");
      const verified = enrolled === (enrollment === "enrolled");
      return {
        supported: true,
        ...(enrolled === null ? {} : { enrollment: enrolled ? "enrolled" : "not_enrolled" }),
        method: "ios_simulator_notifyutil",
        verified,
        ...(verified
          ? {}
          : {
              error: `iOS Simulator biometric enrollment did not verify: expected ${enrollment}.`,
            }),
      };
    } catch (error) {
      return {
        supported: true,
        enrollment,
        method: "ios_simulator_notifyutil",
        verified: false,
        error: errorMessage(error),
      };
    }
  }

  private async getAndroidDoNotDisturb(): Promise<DoNotDisturbState> {
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.device);
      const a11yResult = await a11y.requestSettingsGet("global", "zen_mode");
      if (a11yResult.success) {
        return parseAndroidZenMode(a11yResult.value ?? "");
      }
    } catch (error) {
      logger.debug(`[DeviceState] a11y zen_mode get failed: ${error}`);
    }
    try {
      const adb = this.adbFactory.create(this.device);
      const result = await adb.executeCommand(
        "shell settings get global zen_mode",
        undefined,
        undefined,
        true,
      );
      return parseAndroidZenMode(result.stdout ?? "");
    } catch (error) {
      return {
        supported: true,
        capability: "full",
        error: errorMessage(error),
      };
    }
  }

  private async setAndroidDoNotDisturb(
    input: SetDeviceStateInput["doNotDisturb"],
  ): Promise<DoNotDisturbState> {
    const mode = modeForInput(input);
    try {
      const adb = this.adbFactory.create(this.device);
      const setResult = await adb.executeCommand(
        `shell cmd notification set_dnd ${mode}`,
        undefined,
        undefined,
        true,
      );
      const stdout = setResult.stdout ?? "";
      const stderr = setResult.stderr ?? "";
      if (outputLooksLikeShellFailure(stdout, stderr)) {
        return {
          supported: true,
          capability: "full",
          mode,
          method: "android_cmd_notification",
          error: `${stdout}\n${stderr}`.trim() || "cmd notification set_dnd reported an error",
        };
      }
      const state = await this.getAndroidDoNotDisturb();
      const verified = mode === "off" ? state.enabled === false : state.mode === mode;
      return {
        ...state,
        capability: "full",
        method: "android_cmd_notification",
        verified,
        ...(verified
          ? {}
          : {
              warning: `Requested DND mode ${mode}, read back ${state.mode ?? state.rawValue ?? "unknown"}`,
            }),
      };
    } catch (error) {
      return {
        supported: true,
        capability: "full",
        mode,
        method: "android_cmd_notification",
        error: errorMessage(error),
      };
    }
  }

  private async getIosDoNotDisturb(): Promise<DoNotDisturbState> {
    // No iOS target — simulator or physical — can report DND. Simulators are
    // covered by IOS_SIM_DND_UNSUPPORTED_ERROR (donotdisturbd owns the legacy
    // key on every obtainable runtime); physical devices have no public API at
    // all. Neither issues a notifyutil read, because a read would return a
    // confident falsehood (always `0`) rather than the real Focus state.
    return {
      supported: false,
      capability: "unsupported",
      error: isIosSimulatorDevice(this.device)
        ? IOS_SIM_DND_UNSUPPORTED_ERROR
        : IOS_PHYSICAL_DND_UNSUPPORTED_ERROR,
    };
  }

  private async setIosDoNotDisturb(
    input: SetDeviceStateInput["doNotDisturb"],
  ): Promise<DoNotDisturbState> {
    const requestedMode = modeForInput(input);

    // Neither iOS simulators nor physical devices can have DND set. The legacy
    // com.apple.donotdisturb.enabled notification is owned and reset by the
    // donotdisturbd Focus daemon on every runtime we can obtain, so writing it
    // would post a notification that changes nothing and cannot be verified.
    // Return without issuing any notifyutil write rather than reporting a
    // best-effort success that is really a no-op.
    return {
      supported: false,
      capability: "unsupported",
      requestedMode,
      verified: false,
      error: isIosSimulatorDevice(this.device)
        ? IOS_SIM_DND_UNSUPPORTED_ERROR
        : IOS_PHYSICAL_DND_UNSUPPORTED_ERROR,
    };
  }
}
