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
import {
  iosMajorVersionFromSimctlListDevices,
  parseIosMajorVersion,
} from "../../utils/ios-cmdline-tools/iosVersion";

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

const IOS_DND_NOTIFICATION = "com.apple.donotdisturb.enabled";
const IOS_DND_INDEPENDENT_READBACK_SETTLE_MS = 500;
const IOS_BIOMETRIC_ENROLLMENT_NOTIFICATION = "com.apple.BiometricKit.enrollmentChanged";
const IOS_BIOMETRICS_UNSUPPORTED_ERROR =
  "Biometric enrollment state can only be read or set on an iOS Simulator.";

/**
 * Physical iOS devices expose no public API to enable/disable Focus or Do Not
 * Disturb. The only sanctioned app-side hook is the read-only Focus Filter API
 * (apps react to an active Focus, they cannot set one), and Apple's device
 * tooling (devicectl, XCUITest) ships no DND/Focus setter. DND automation is
 * therefore simulator-only.
 */
const IOS_PHYSICAL_DND_UNSUPPORTED_ERROR =
  "Do Not Disturb cannot be set on a physical iOS device: iOS exposes no public API to " +
  "enable/disable Focus or Do Not Disturb (only the read-only Focus Filter API). " +
  "Use an iOS Simulator for DND automation, or trigger DND manually / via a Shortcuts automation on device.";

/** Last iOS major version where the legacy binary-DND notification is expected to work. */
const IOS_DND_LEGACY_NOTIFICATION_LAST_SUPPORTED_MAJOR = 17;

/**
 * iOS 18 moved Do Not Disturb / Focus to the `com.apple.donotdisturbd` daemon
 * (private Core Data store + a Focus-assertion model). That daemon now owns the
 * legacy `com.apple.donotdisturb.enabled` Darwin notification and immediately
 * resets it to its authoritative value: empirically, a value posted via
 * `notifyutil -s` is read back as `0` from a fresh process even sub-second later,
 * while an unmanaged notify key (e.g. BiometricKit's) set the same way persists.
 * So the legacy key neither reflects nor controls the real Focus state — a write
 * cannot verify and a read is a confident falsehood (always `0`). Apple ships no
 * public API to read or set Focus/DND. The version check is only a fast-path:
 * legacy writes that are attempted must still prove persistence with an
 * independent fresh-process readback before reporting success.
 */
const IOS18_SIM_DND_UNSUPPORTED_ERROR =
  "Do Not Disturb cannot be reliably read or set on an iOS 18+ simulator: iOS 18 moved Do Not " +
  "Disturb to the donotdisturbd Focus daemon, which owns the state in a private store and resets " +
  "the legacy com.apple.donotdisturb.enabled notification — so that notification neither reflects " +
  "nor controls the real Focus state. iOS exposes no public API to read or set Focus / Do Not " +
  "Disturb. Use an iOS 17 or earlier simulator for binary DND automation, or set it manually / via " +
  "a Shortcuts automation.";

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

function iosDndStateFromNotifyutilOutput(raw: string): DoNotDisturbState {
  const enabled = parseNotifyutilState(raw);
  if (enabled === null) {
    return {
      supported: true,
      capability: "binary",
      method: "ios_simulator_notifyutil",
      bestEffort: true,
      rawValue: raw,
      warning: "Could not parse iOS simulator Do Not Disturb notifyutil state",
    };
  }

  return {
    supported: true,
    capability: "binary",
    enabled,
    mode: enabled ? "none" : "off",
    rawValue: enabled ? "1" : "0",
    method: "ios_simulator_notifyutil",
    bestEffort: true,
  };
}

function iosDndUnsupportedReadbackResult(
  state: DoNotDisturbState,
  requestedMode: DoNotDisturbMode,
  requestedEnabled: boolean,
  reason: string,
): DoNotDisturbState {
  const observed = state.enabled === undefined ? "unknown" : state.enabled ? "enabled" : "disabled";
  const requested = requestedEnabled ? "enabled" : "disabled";
  return {
    ...state,
    supported: false,
    capability: "unsupported",
    requestedMode,
    verified: false,
    bestEffort: true,
    error: `iOS simulator Do Not Disturb write did not persist: independent notifyutil readback observed ${observed} after requesting ${requested}. ${reason}`,
  };
}

/**
 * Builds the honest warning for an iOS simulator DND write when the binary
 * state verified, but the requested priority/alarms tier cannot be represented.
 */
function iosDndSetWarning(
  requestedMode: DoNotDisturbMode,
  downgraded: boolean,
): string | undefined {
  if (downgraded) {
    const tier =
      `iOS DND is binary on the simulator; requested "${requestedMode}" has no per-mode/priority/alarms ` +
      "fidelity (no public Focus API)";
    return `${tier}, so it was applied as plain DND.`;
  }
  return undefined;
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
    if (!isIosSimulatorDevice(this.device)) {
      return {
        supported: false,
        capability: "unsupported",
        error: IOS_PHYSICAL_DND_UNSUPPORTED_ERROR,
      };
    }

    const simctl = this.simctl ?? new SimCtlClient(this.device);

    // iOS 18+ simulators: the legacy key is owned/reset by donotdisturbd, so
    // `notifyutil -g` always reads `0` regardless of the real Focus state. Report
    // unsupported rather than a confident falsehood — symmetric with the write
    // path. iOS <18 (and unknown) keep the legacy best-effort read below.
    const iosMajor = await this.resolveSimulatorIosMajorVersion(simctl);
    if (iosMajor !== null && iosMajor > IOS_DND_LEGACY_NOTIFICATION_LAST_SUPPORTED_MAJOR) {
      return {
        supported: false,
        capability: "unsupported",
        error: IOS18_SIM_DND_UNSUPPORTED_ERROR,
      };
    }

    try {
      const result = await simctl.executeCommand(
        iosNotifyutilGetCommand(this.device.deviceId, IOS_DND_NOTIFICATION),
      );
      return iosDndStateFromNotifyutilOutput(result.stdout ?? "");
    } catch (error) {
      return {
        supported: true,
        capability: "binary",
        method: "ios_simulator_notifyutil",
        bestEffort: true,
        error: errorMessage(error),
      };
    }
  }

  /**
   * Resolve the simulator's major iOS version. Prefers the version already on the
   * `BootedDevice` (populated by the daemon device pool); falls back to a live
   * `simctl list devices <udid> --json` probe. Returns `null` when the version
   * cannot be determined, so callers treat it as "unknown". Non-iOS runtimes
   * (visionOS/tvOS/watchOS simulators) also resolve to `null` and fall through to
   * the harmless legacy path — they are not real DND targets.
   */
  private async resolveSimulatorIosMajorVersion(
    simctl: IosSimulatorClient,
  ): Promise<number | null> {
    const fromDevice = parseIosMajorVersion(this.device.iosVersion ?? this.device.osVersion);
    if (fromDevice !== null) {
      return fromDevice;
    }
    try {
      const result = await simctl.executeCommand(`list devices ${this.device.deviceId} --json`);
      return iosMajorVersionFromSimctlListDevices(result.stdout ?? "", this.device.deviceId);
    } catch (error) {
      logger.warn(
        `[DeviceState] could not resolve iOS version for ${this.device.deviceId}: ` +
          `${errorMessage(error)}`,
        error,
      );
      return null;
    }
  }

  private async setIosDoNotDisturb(
    input: SetDeviceStateInput["doNotDisturb"],
  ): Promise<DoNotDisturbState> {
    const requestedMode = modeForInput(input);

    // Physical iOS devices: precise, structured "not supported and why" — there
    // is no public API to set Focus/DND, so this is an early return with no write.
    if (!isIosSimulatorDevice(this.device)) {
      return {
        supported: false,
        capability: "unsupported",
        requestedMode,
        error: IOS_PHYSICAL_DND_UNSUPPORTED_ERROR,
      };
    }

    const simctl = this.simctl ?? new SimCtlClient(this.device);

    // Known iOS 18+ simulators skip the legacy probe as a fast-path optimization:
    // the key is owned/reset by donotdisturbd there. Unknown and older runtimes
    // still attempt the legacy path, then prove behavior with a fresh readback.
    const iosMajor = await this.resolveSimulatorIosMajorVersion(simctl);
    const versionKnown = iosMajor !== null;
    if (iosMajor !== null && iosMajor > IOS_DND_LEGACY_NOTIFICATION_LAST_SUPPORTED_MAJOR) {
      return {
        supported: false,
        capability: "unsupported",
        requestedMode,
        verified: false,
        error: IOS18_SIM_DND_UNSUPPORTED_ERROR,
      };
    }

    // Simulator legacy path: the only lever is the binary `com.apple.donotdisturb.enabled`
    // Darwin notification. The set command self-registers so keys without some
    // other live owner are still writable in-process, but that same-invocation
    // set/read/post is not authoritative: donotdisturbd can reclaim the key
    // immediately, so success depends on the independent fresh-process readback below.
    // There is no per-mode (priority/alarms) Darwin notification analogous to
    // Android's `zen_mode` integer, so `priority`/`alarms` requests are applied
    // as plain DND ("none") and reported honestly rather than silently claiming
    // the tier was honored.
    const requestedEnabled = requestedMode !== "off";
    const appliedMode: DoNotDisturbMode = requestedEnabled ? "none" : "off";
    const downgraded = requestedMode === "priority" || requestedMode === "alarms";

    try {
      const value = requestedEnabled ? "1" : "0";
      const writeResult = await simctl.executeCommand(
        iosNotifyutilRegisteredSetReadPostCommand(
          this.device.deviceId,
          IOS_DND_NOTIFICATION,
          value,
        ),
        IOS_NOTIFYUTIL_REGISTERED_SET_TIMEOUT_MS,
      );
      const writeStderr = writeResult.stderr?.trim();
      if (writeStderr) {
        return {
          supported: true,
          capability: "binary",
          requestedMode,
          method: "ios_simulator_notifyutil",
          bestEffort: true,
          error: `notifyutil failed: ${writeStderr}`,
        };
      }

      await this.timer.sleep(IOS_DND_INDEPENDENT_READBACK_SETTLE_MS);
      const readbackResult = await simctl.executeCommand(
        iosNotifyutilGetCommand(this.device.deviceId, IOS_DND_NOTIFICATION),
      );
      const state = iosDndStateFromNotifyutilOutput(readbackResult.stdout ?? "");
      const stateMatches = state.enabled === requestedEnabled;
      if (!stateMatches) {
        return iosDndUnsupportedReadbackResult(
          state,
          requestedMode,
          requestedEnabled,
          "The runtime may reset the legacy com.apple.donotdisturb.enabled notification via donotdisturbd.",
        );
      }
      if (!requestedEnabled && !versionKnown) {
        return iosDndUnsupportedReadbackResult(
          state,
          requestedMode,
          requestedEnabled,
          "The simulator iOS version is unknown, and an off request reading back disabled does not prove the legacy DND notification can enable DND.",
        );
      }
      // For priority/alarms we applied *a* DND state but NOT the requested tier,
      // so verified is intentionally false: setState() will then report
      // success:false, surfacing the unfulfillable request instead of hiding it.
      const verified = stateMatches && !downgraded;

      const warning = iosDndSetWarning(requestedMode, downgraded);

      // Only assert an applied mode when the binary readback confirmed the
      // requested enabled state. If it did not, we cannot claim plain DND was
      // applied — leave `appliedMode` unset and let `mode`/`enabled` reflect
      // what the readback actually observed (via the `...state` spread).
      const appliedFields = stateMatches ? { appliedMode, mode: appliedMode } : {};

      return {
        ...state,
        capability: "binary",
        requestedMode,
        ...appliedFields,
        verified,
        bestEffort: true,
        ...(warning ? { warning } : {}),
      };
    } catch (error) {
      return {
        supported: true,
        capability: "binary",
        requestedMode,
        method: "ios_simulator_notifyutil",
        bestEffort: true,
        error: errorMessage(error),
      };
    }
  }
}
