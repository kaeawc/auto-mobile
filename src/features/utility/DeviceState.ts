import { defaultAdbClientFactory, type AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice, ExecResult } from "../../models";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { isIosSimulatorDevice } from "../action/IosSimulatorPermissions";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import { logger } from "../../utils/logger";

export type DoNotDisturbMode = "off" | "none" | "priority" | "alarms";

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

function parseAndroidZenMode(raw: string): DoNotDisturbState {
  const value = raw.trim();
  switch (value) {
    case "0":
      return {
        supported: true,
        enabled: false,
        mode: "off",
        rawValue: value,
        method: "android_settings_zen_mode",
      };
    case "1":
      return {
        supported: true,
        enabled: true,
        mode: "priority",
        rawValue: value,
        method: "android_settings_zen_mode",
      };
    case "2":
      return {
        supported: true,
        enabled: true,
        mode: "none",
        rawValue: value,
        method: "android_settings_zen_mode",
      };
    case "3":
      return {
        supported: true,
        enabled: true,
        mode: "alarms",
        rawValue: value,
        method: "android_settings_zen_mode",
      };
    default:
      return {
        supported: true,
        rawValue: value,
        method: "android_settings_zen_mode",
        warning: `Unknown Android zen_mode value: ${value}`,
      };
  }
}

function parseNotifyutilState(raw: string): boolean | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/([01])\s*$/);
  if (!match) {
    return null;
  }
  return match[1] === "1";
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
          mode,
          method: "android_cmd_notification",
          error: `${stdout}\n${stderr}`.trim() || "cmd notification set_dnd reported an error",
        };
      }
      const state = await this.getAndroidDoNotDisturb();
      const verified = mode === "off" ? state.enabled === false : state.mode === mode;
      return {
        ...state,
        method: "android_cmd_notification",
        verified,
        ...(verified ? {} : { warning: `Requested DND mode ${mode}, read back ${state.mode ?? state.rawValue ?? "unknown"}` }),
      };
    } catch (error) {
      return {
        supported: true,
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
        error: "Do Not Disturb state is only available for iOS simulators",
      };
    }

    try {
      const simctl = this.simctl ?? new SimCtlClient(this.device);
      const result = await simctl.executeCommand(`spawn ${this.device.deviceId} notifyutil -g ${IOS_DND_NOTIFICATION}`);
      const enabled = parseNotifyutilState(result.stdout ?? "");
      if (enabled === null) {
        return {
          supported: true,
          method: "ios_simulator_notifyutil",
          bestEffort: true,
          rawValue: result.stdout,
          warning: "Could not parse iOS simulator Do Not Disturb notifyutil state",
        };
      }

      return {
        supported: true,
        enabled,
        mode: enabled ? "none" : "off",
        rawValue: enabled ? "1" : "0",
        method: "ios_simulator_notifyutil",
        bestEffort: true,
      };
    } catch (error) {
      return {
        supported: true,
        method: "ios_simulator_notifyutil",
        bestEffort: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async setIosDoNotDisturb(input: SetDeviceStateInput["doNotDisturb"]): Promise<DoNotDisturbState> {
    if (!isIosSimulatorDevice(this.device)) {
      return {
        supported: false,
        error: "Do Not Disturb state changes are only available for iOS simulators",
      };
    }

    const mode = modeForInput(input);
    const requestedEnabled = mode !== "off";
    const unsupportedModeWarning = mode === "priority" || mode === "alarms"
      ? `iOS simulator Do Not Disturb supports only binary enabled/off state; requested ${mode}, applied enabled state`
      : undefined;
    try {
      const simctl = this.simctl ?? new SimCtlClient(this.device);
      const value = requestedEnabled ? "1" : "0";
      await simctl.executeCommand(`spawn ${this.device.deviceId} notifyutil -s ${IOS_DND_NOTIFICATION} ${value}`);
      await simctl.executeCommand(`spawn ${this.device.deviceId} notifyutil -p ${IOS_DND_NOTIFICATION}`);

      const state = await this.getIosDoNotDisturb();
      const verified = state.enabled === requestedEnabled;
      return {
        ...state,
        mode: requestedEnabled ? "none" : "off",
        verified,
        bestEffort: true,
        ...(verified
          ? (unsupportedModeWarning ? { warning: unsupportedModeWarning } : {})
          : { warning: "iOS simulator Do Not Disturb notification was posted, but notifyutil state did not verify the requested value" }),
      };
    } catch (error) {
      return {
        supported: true,
        mode,
        method: "ios_simulator_notifyutil",
        bestEffort: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
