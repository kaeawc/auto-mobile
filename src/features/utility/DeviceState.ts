import { defaultAdbClientFactory, type AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice, ExecResult } from "../../models";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { isIosSimulatorDevice } from "../action/IosSimulatorPermissions";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import { logger } from "../../utils/logger";
import {
  IOS_NOTIFYUTIL_REGISTERED_SET_TIMEOUT_MS,
  iosNotifyutilGetCommand,
  iosNotifyutilRegisteredSetCommand,
  parseNotifyutilState
} from "../../utils/ios-cmdline-tools/notifyutil";
import {
  iosMajorVersionFromSimctlListDevices,
  parseIosMajorVersion
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

export interface DeviceStateResult {
  success: boolean;
  deviceId: string;
  platform: "android" | "ios";
  doNotDisturb?: DoNotDisturbState;
  error?: string;
}

export interface SetDeviceStateInput {
  doNotDisturb?: {
    enabled?: boolean;
    mode?: DoNotDisturbMode;
  };
}

interface IosSimulatorClient {
  executeCommand(command: string, timeoutMs?: number): Promise<ExecResult>;
}

export interface DeviceStateDependencies {
  adbFactory?: AdbClientFactory;
  simctl?: IosSimulatorClient | null;
}

const IOS_DND_NOTIFICATION = "com.apple.donotdisturb.enabled";

/**
 * Physical iOS devices expose no public API to enable/disable Focus or Do Not
 * Disturb. The only sanctioned app-side hook is the read-only Focus Filter API
 * (apps react to an active Focus, they cannot set one), and Apple's device
 * tooling (devicectl, XCUITest) ships no DND/Focus setter. DND automation is
 * therefore simulator-only.
 */
const IOS_PHYSICAL_DND_UNSUPPORTED_ERROR =
  "Do Not Disturb cannot be set on a physical iOS device: iOS exposes no public API to "
  + "enable/disable Focus or Do Not Disturb (only the read-only Focus Filter API). "
  + "Use an iOS Simulator for DND automation, or trigger DND manually / via a Shortcuts automation on device.";

/** iOS major version at/after which the legacy binary-DND notification is dead. */
const IOS_DND_LEGACY_NOTIFICATION_LAST_SUPPORTED_MAJOR = 17;

/**
 * iOS 18 moved Do Not Disturb / Focus to the `com.apple.donotdisturbd` daemon
 * (Core Data store + a Focus-assertion model). The legacy
 * `com.apple.donotdisturb.enabled` Darwin notification is no longer authoritative:
 * its state is not persisted past the setting process (notify(3): a key's state
 * only exists while a registration is held) and `donotdisturbd` does not consume
 * it, so a posted toggle can never verify. Apple ships no public API to set
 * Focus/DND, so on iOS 18+ simulators the write path honestly reports unsupported
 * rather than posting a notification that has no effect.
 */
const IOS18_SIM_DND_UNSUPPORTED_ERROR =
  "Do Not Disturb cannot be reliably set on an iOS 18+ simulator: iOS 18 moved Do Not Disturb to "
  + "the donotdisturbd Focus daemon, and the legacy com.apple.donotdisturb.enabled notification is "
  + "non-authoritative — its state is not persisted and donotdisturbd does not consume it, so the "
  + "toggle cannot be verified. iOS exposes no public API to set Focus / Do Not Disturb. Use an "
  + "iOS 17 or earlier simulator for binary DND automation, or set it manually / via a Shortcuts automation.";

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

/**
 * Builds the honest warning for an iOS simulator DND write. The two failure
 * axes are independent and must both be surfaced:
 * - `downgraded`: a `priority`/`alarms` tier was requested but only plain binary
 *   DND is available.
 * - `!stateMatches`: the binary `notifyutil -g` readback did not confirm the
 *   requested enabled state — so we cannot even assert plain DND was applied.
 */
function iosDndSetWarning(
  requestedMode: DoNotDisturbMode,
  downgraded: boolean,
  stateMatches: boolean
): string | undefined {
  const readbackFailed =
    "the binary DND toggle did not verify: notifyutil did not read back the requested state.";
  if (downgraded) {
    const tier = `iOS DND is binary on the simulator; requested "${requestedMode}" has no per-mode/priority/alarms `
      + "fidelity (no public Focus API)";
    return stateMatches
      ? `${tier}, so it was applied as plain DND.`
      : `${tier}, and ${readbackFailed}`;
  }
  if (!stateMatches) {
    return `iOS simulator Do Not Disturb notification was posted, but ${readbackFailed}`;
  }
  return undefined;
}

function modeForInput(input: SetDeviceStateInput["doNotDisturb"]): DoNotDisturbMode {
  if (input?.mode) {
    return input.mode;
  }
  return input?.enabled === false ? "off" : "none";
}

export class DeviceState {
  private device: BootedDevice;

  private adbFactory: AdbClientFactory;

  private simctl: IosSimulatorClient | null;

  constructor(device: BootedDevice, dependencies: DeviceStateDependencies = {}) {
    this.device = device;
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.simctl = dependencies.simctl ?? null;
  }

  async getState(): Promise<DeviceStateResult> {
    const doNotDisturb = this.device.platform === "android"
      ? await this.getAndroidDoNotDisturb()
      : await this.getIosDoNotDisturb();

    return {
      success: doNotDisturb.supported && !doNotDisturb.error,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      doNotDisturb,
      ...(doNotDisturb.error ? { error: doNotDisturb.error } : {}),
    };
  }

  async setState(input: SetDeviceStateInput): Promise<DeviceStateResult> {
    if (!input.doNotDisturb) {
      return {
        success: false,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        error: "At least one device state field must be provided",
      };
    }

    const { enabled, mode } = input.doNotDisturb;
    if (enabled !== undefined && mode !== undefined) {
      const impliesOff = enabled === false;
      const modeIsOff = mode === "off";
      if (impliesOff !== modeIsOff) {
        return {
          success: false,
          deviceId: this.device.deviceId,
          platform: this.device.platform,
          error: `doNotDisturb.enabled=${enabled} conflicts with doNotDisturb.mode="${mode}"`,
        };
      }
    }

    const doNotDisturb = this.device.platform === "android"
      ? await this.setAndroidDoNotDisturb(input.doNotDisturb)
      : await this.setIosDoNotDisturb(input.doNotDisturb);

    return {
      success: doNotDisturb.supported && !doNotDisturb.error && doNotDisturb.verified !== false,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      doNotDisturb,
      ...(doNotDisturb.error ? { error: doNotDisturb.error } : {}),
    };
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
      const result = await adb.executeCommand("shell settings get global zen_mode", undefined, undefined, true);
      return parseAndroidZenMode(result.stdout ?? "");
    } catch (error) {
      return {
        supported: true,
        capability: "full",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async setAndroidDoNotDisturb(input: SetDeviceStateInput["doNotDisturb"]): Promise<DoNotDisturbState> {
    const mode = modeForInput(input);
    try {
      const adb = this.adbFactory.create(this.device);
      const setResult = await adb.executeCommand(`shell cmd notification set_dnd ${mode}`, undefined, undefined, true);
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
        ...(verified ? {} : { warning: `Requested DND mode ${mode}, read back ${state.mode ?? state.rawValue ?? "unknown"}` }),
      };
    } catch (error) {
      return {
        supported: true,
        capability: "full",
        mode,
        method: "android_cmd_notification",
        error: error instanceof Error ? error.message : String(error),
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

    try {
      const simctl = this.simctl ?? new SimCtlClient(this.device);
      const result = await simctl.executeCommand(
        iosNotifyutilGetCommand(this.device.deviceId, IOS_DND_NOTIFICATION)
      );
      return iosDndStateFromNotifyutilOutput(result.stdout ?? "");
    } catch (error) {
      return {
        supported: true,
        capability: "binary",
        method: "ios_simulator_notifyutil",
        bestEffort: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Resolve the simulator's major iOS version. Prefers the version already on the
   * `BootedDevice` (populated by the daemon device pool); falls back to a live
   * `simctl list devices <udid> --json` probe. Returns `null` when the version
   * cannot be determined, so callers treat it as "unknown".
   */
  private async resolveSimulatorIosMajorVersion(simctl: IosSimulatorClient): Promise<number | null> {
    const fromDevice = parseIosMajorVersion(this.device.iosVersion ?? this.device.osVersion);
    if (fromDevice !== null) {
      return fromDevice;
    }
    try {
      const result = await simctl.executeCommand(`list devices ${this.device.deviceId} --json`);
      return iosMajorVersionFromSimctlListDevices(result.stdout ?? "", this.device.deviceId);
    } catch (error) {
      logger.warn(
        `[DeviceState] could not resolve iOS version for ${this.device.deviceId}: `
        + `${error instanceof Error ? error.message : String(error)}`,
        error
      );
      return null;
    }
  }

  private async setIosDoNotDisturb(input: SetDeviceStateInput["doNotDisturb"]): Promise<DoNotDisturbState> {
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

    // iOS 18+ simulators: the legacy binary-DND notification is dead (DND moved to
    // donotdisturbd, which does not consume it, and the notify state does not
    // persist past the setting process — so a posted toggle can never verify).
    // Report unsupported and issue no misleading notifyutil write, mirroring the
    // physical-device early return. iOS <18 (and unknown) keep the legacy
    // best-effort path below.
    const iosMajor = await this.resolveSimulatorIosMajorVersion(simctl);
    if (iosMajor !== null && iosMajor > IOS_DND_LEGACY_NOTIFICATION_LAST_SUPPORTED_MAJOR) {
      return {
        supported: false,
        capability: "unsupported",
        requestedMode,
        verified: false,
        error: IOS18_SIM_DND_UNSUPPORTED_ERROR,
      };
    }

    // Simulator (iOS <18): the only lever is the binary `com.apple.donotdisturb.enabled`
    // Darwin notification. `notifyutil -s` is a no-op unless the key has a
    // registration, so set/read/post must happen in one registered invocation.
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
        iosNotifyutilRegisteredSetCommand(this.device.deviceId, IOS_DND_NOTIFICATION, value),
        IOS_NOTIFYUTIL_REGISTERED_SET_TIMEOUT_MS
      );
      const state = iosDndStateFromNotifyutilOutput(writeResult.stdout ?? "");
      const stateMatches = state.enabled === requestedEnabled;
      // For priority/alarms we applied *a* DND state but NOT the requested tier,
      // so verified is intentionally false: setState() will then report
      // success:false, surfacing the unfulfillable request instead of hiding it.
      const verified = stateMatches && !downgraded;

      const warning = iosDndSetWarning(requestedMode, downgraded, stateMatches);

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
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
