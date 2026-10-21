import { BootedDevice } from "../models";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "./android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "./android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "./logger";
import { errorMessage } from "./describeUnknownError";
import { defaultDeviceTraits, type DeviceTraits } from "./android-cmdline-tools/deviceTraits";

export interface KeepScreenAwakeSettingsClient {
  requestSettingsGet(
    namespace: "global" | "system",
    key: string,
  ): Promise<{ success: boolean; found: boolean; value?: string }>;
  requestSettingsPut(
    namespace: "global" | "system",
    key: string,
    value: string | null,
    valueType?: "string" | "int" | "long" | "float",
  ): Promise<{ success: boolean }>;
}

export type KeepScreenAwakeState = {
  applied: boolean;
  method?: "svc" | "settings";
  skipReason?: "disabled" | "emulator" | "unsupported" | "detection_failed" | "failed";
  svcWasEnabled?: boolean;
  originalStayOnWhilePluggedIn?: string | null;
  originalScreenOffTimeout?: string | null;
  appliedSettings?: {
    stayOnWhilePluggedIn: boolean;
    screenOffTimeout: boolean;
  };
};

type BaselineSetting = {
  setting: "svc_stayon" | "stay_on_while_plugged_in" | "screen_off_timeout";
  value: string;
};

/** Serializable release evidence when restoration could not recover the original settings. */
export interface KeepAwakeRestoreReport {
  status: "restored_to_baseline" | "failed";
  settings: Array<{ setting: string; value?: string; error?: string }>;
}

export type KeepScreenAwakeRestoreOutcome =
  | { status: "restored" }
  | { status: "restored_to_baseline"; settings: ReadonlyArray<BaselineSetting> }
  | { status: "skipped"; reason: "not_applied" }
  | {
      status: "failed";
      baselineSettings?: ReadonlyArray<BaselineSetting>;
      failures: ReadonlyArray<{
        setting: "svc_stayon" | "stay_on_while_plugged_in" | "screen_off_timeout";
        error: string;
      }>;
    };

type DeviceType = "emulator" | "physical" | "unknown";

const STAY_ON_WHILE_PLUGGED_IN_MASK = "7";
const MAX_SCREEN_OFF_TIMEOUT_MS = "2147483647";
const DEFAULT_STAY_ON_WHILE_PLUGGED_IN = "0";
const DEFAULT_SCREEN_OFF_TIMEOUT_MS = "60000";

export class KeepScreenAwakeManager {
  private device: BootedDevice;
  private adb: Pick<AdbExecutor, "executeCommand">;

  constructor(
    device: BootedDevice,
    adbFactory: {
      create: (
        ...args: Parameters<AdbClientFactory["create"]>
      ) => Pick<AdbExecutor, "executeCommand">;
    } = defaultAdbClientFactory,
    private readonly settingsClientProvider: (
      device: BootedDevice,
    ) => KeepScreenAwakeSettingsClient,
    private readonly deviceTraits: DeviceTraits = defaultDeviceTraits,
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
  }

  async apply(keepScreenAwake: boolean): Promise<KeepScreenAwakeState> {
    if (!keepScreenAwake) {
      return { applied: false, skipReason: "disabled" };
    }

    if (this.device.platform !== "android") {
      return { applied: false, skipReason: "unsupported" };
    }

    const deviceType = await this.detectDeviceType();
    if (deviceType === "emulator") {
      return { applied: false, skipReason: "emulator" };
    }
    if (deviceType === "unknown") {
      logger.warn(
        `[KeepScreenAwake] Unable to detect device type for ${this.device.deviceId}; skipping keep-awake`,
      );
      return { applied: false, skipReason: "detection_failed" };
    }

    await this.wakeDevice();

    const svcState = await this.readSvcStayonState();
    if (await this.tryEnableSvcStayon()) {
      const verifiedSvcState = await this.readSvcStayonState();
      if (verifiedSvcState.enabled === true) {
        return {
          applied: true,
          method: "svc",
          svcWasEnabled: svcState.enabled,
          originalStayOnWhilePluggedIn: svcState.value,
        };
      }
      if (verifiedSvcState.value === undefined) {
        logger.warn(
          `[KeepScreenAwake] Unable to verify svc stayon on ${this.device.deviceId}; falling back to settings`,
        );
      } else {
        logger.warn(
          `[KeepScreenAwake] svc stayon did not enable stay_on_while_plugged_in on ${this.device.deviceId}; falling back to settings`,
        );
      }
    }

    const settingsResult = await this.applySettingsFallback();
    if (!settingsResult.applied) {
      logger.warn(`[KeepScreenAwake] Failed to keep screen awake on ${this.device.deviceId}`);
      return { applied: false, skipReason: "failed" };
    }

    return {
      applied: true,
      method: "settings",
      originalStayOnWhilePluggedIn: settingsResult.originalStayOnWhilePluggedIn,
      originalScreenOffTimeout: settingsResult.originalScreenOffTimeout,
      appliedSettings: settingsResult.appliedSettings,
    };
  }

  async restore(state: KeepScreenAwakeState): Promise<KeepScreenAwakeRestoreOutcome> {
    if (!state.applied || this.device.platform !== "android") {
      return { status: "skipped", reason: "not_applied" };
    }
    if (state.method === "svc") {
      return this.restoreSvcStayon(state);
    }
    if (state.method !== "settings" || !state.appliedSettings) {
      return { status: "skipped", reason: "not_applied" };
    }
    const failures: Array<
      Extract<KeepScreenAwakeRestoreOutcome, { status: "failed" }>["failures"][number]
    > = [];
    const baselineSettings: BaselineSetting[] = [];
    for (const [applied, scope, key, originalValue, valueType] of [
      [
        state.appliedSettings.stayOnWhilePluggedIn,
        "global",
        "stay_on_while_plugged_in",
        state.originalStayOnWhilePluggedIn,
        "int",
      ],
      [
        state.appliedSettings.screenOffTimeout,
        "system",
        "screen_off_timeout",
        state.originalScreenOffTimeout,
        "long",
      ],
    ] as const) {
      if (!applied) {
        continue;
      }
      const outcome = await this.restoreSetting(scope, key, originalValue, valueType);
      if (outcome.status === "failed") {
        failures.push(...outcome.failures);
      } else if (outcome.status === "restored_to_baseline") {
        baselineSettings.push(...outcome.settings);
      }
    }
    return this.restoreOutcome(failures, baselineSettings);
  }

  private async restoreSvcStayon(
    state: KeepScreenAwakeState,
  ): Promise<KeepScreenAwakeRestoreOutcome> {
    let settingFailure: KeepScreenAwakeRestoreOutcome | undefined;
    if (state.originalStayOnWhilePluggedIn !== undefined) {
      const originalEnabled = this.parseStayOnWhilePluggedIn(state.originalStayOnWhilePluggedIn);
      const outcome = await this.restoreSetting(
        "global",
        "stay_on_while_plugged_in",
        state.originalStayOnWhilePluggedIn,
        "int",
      );
      if (outcome.status === "restored") {
        return outcome;
      }
      if (originalEnabled !== false) {
        if (originalEnabled === undefined) {
          logger.warn(
            `[KeepScreenAwake] Failed svc stayon restore on ${this.device.deviceId}: original value unparseable`,
          );
        }
        return outcome;
      }
      settingFailure = outcome;
    } else {
      if (state.svcWasEnabled === undefined) {
        return this.restoreUnknownSvcStayon();
      }
      if (state.svcWasEnabled) {
        return { status: "restored" };
      }
    }
    try {
      await this.adb.executeCommand("shell svc power stayon false");
      return { status: "restored" };
    } catch (error) {
      logger.warn(
        `[KeepScreenAwake] Failed to disable svc stayon on ${this.device.deviceId}: ${error}`,
      );
      return {
        status: "failed",
        failures: [
          ...(settingFailure?.status === "failed" ? settingFailure.failures : []),
          { setting: "svc_stayon", error: errorMessage(error) },
        ],
      };
    }
  }

  /** Unknown svc state needs both a known setting value and the svc disable command. */
  private async restoreUnknownSvcStayon(): Promise<KeepScreenAwakeRestoreOutcome> {
    const outcome = await this.restoreSetting(
      "global",
      "stay_on_while_plugged_in",
      undefined,
      "int",
    );
    const baselineSettings: BaselineSetting[] =
      outcome.status === "restored_to_baseline" ? [...outcome.settings] : [];
    const failures = outcome.status === "failed" ? [...outcome.failures] : [];
    try {
      await this.adb.executeCommand("shell svc power stayon false");
      baselineSettings.push({ setting: "svc_stayon", value: "svc stayon false" });
    } catch (error) {
      logger.warn(
        `[KeepScreenAwake] Failed to disable svc stayon on ${this.device.deviceId}: ${error}`,
        error,
      );
      failures.push({ setting: "svc_stayon", error: errorMessage(error) });
    }
    return this.restoreOutcome(failures, baselineSettings);
  }

  private restoreOutcome(
    failures: Extract<KeepScreenAwakeRestoreOutcome, { status: "failed" }>["failures"],
    baselineSettings: ReadonlyArray<BaselineSetting>,
  ): KeepScreenAwakeRestoreOutcome {
    if (failures.length) {
      return {
        status: "failed",
        failures,
        ...(baselineSettings.length ? { baselineSettings } : {}),
      };
    }
    return baselineSettings.length
      ? { status: "restored_to_baseline", settings: baselineSettings }
      : { status: "restored" };
  }

  private async detectDeviceType(): Promise<DeviceType> {
    if (this.device.deviceId.startsWith("emulator-")) {
      return "emulator";
    }

    try {
      const { isEmulator } = await this.deviceTraits.read(this.adb, this.device.deviceId);
      if (isEmulator === true) {
        return "emulator";
      }
      if (isEmulator === false) {
        return "physical";
      }
      logger.warn(
        `[KeepScreenAwake] Unexpected emulator flag on ${this.device.deviceId}; device type unknown`,
      );
      return "unknown";
    } catch (error) {
      logger.warn(
        `[KeepScreenAwake] Failed to read device traits on ${this.device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      return "unknown";
    }
  }

  private async wakeDevice(): Promise<void> {
    try {
      await this.adb.executeCommand("shell input keyevent KEYCODE_WAKEUP");
    } catch (error) {
      logger.warn(`[KeepScreenAwake] Failed to wake ${this.device.deviceId}: ${error}`);
    }
  }

  private async tryEnableSvcStayon(): Promise<boolean> {
    try {
      await this.adb.executeCommand("shell svc power stayon true");
      return true;
    } catch (error) {
      logger.info(
        `[KeepScreenAwake] svc power stayon failed on ${this.device.deviceId}, falling back: ${error}`,
      );
      return false;
    }
  }

  private async applySettingsFallback(): Promise<{
    applied: boolean;
    originalStayOnWhilePluggedIn?: string | null;
    originalScreenOffTimeout?: string | null;
    appliedSettings: {
      stayOnWhilePluggedIn: boolean;
      screenOffTimeout: boolean;
    };
  }> {
    const originalStayOnWhilePluggedIn = await this.readSetting(
      "global",
      "stay_on_while_plugged_in",
    );
    const originalScreenOffTimeout = await this.readSetting("system", "screen_off_timeout");
    const appliedSettings = {
      stayOnWhilePluggedIn: false,
      screenOffTimeout: false,
    };

    try {
      await this.putSetting(
        "global",
        "stay_on_while_plugged_in",
        STAY_ON_WHILE_PLUGGED_IN_MASK,
        "int",
      );
      appliedSettings.stayOnWhilePluggedIn = true;
    } catch (error) {
      logger.warn(
        `[KeepScreenAwake] Failed to set stay_on_while_plugged_in on ${this.device.deviceId}: ${error}`,
      );
    }

    try {
      await this.putSetting("system", "screen_off_timeout", MAX_SCREEN_OFF_TIMEOUT_MS, "long");
      appliedSettings.screenOffTimeout = true;
    } catch (error) {
      logger.warn(
        `[KeepScreenAwake] Failed to set screen_off_timeout on ${this.device.deviceId}: ${error}`,
      );
    }

    return {
      applied: appliedSettings.stayOnWhilePluggedIn || appliedSettings.screenOffTimeout,
      originalStayOnWhilePluggedIn,
      originalScreenOffTimeout,
      appliedSettings,
    };
  }

  private async readSvcStayonState(): Promise<{
    value: string | null | undefined;
    enabled: boolean | undefined;
  }> {
    const value = await this.readSetting("global", "stay_on_while_plugged_in");
    return {
      value,
      enabled: this.parseStayOnWhilePluggedIn(value),
    };
  }

  private parseStayOnWhilePluggedIn(value?: string | null): boolean | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return false;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
    const parsed = Number.parseInt(normalized, 10);
    if (Number.isNaN(parsed)) {
      return undefined;
    }
    return parsed !== 0;
  }

  private async readSetting(
    scope: "global" | "system",
    key: string,
  ): Promise<string | null | undefined> {
    try {
      const a11y = this.settingsClientProvider(this.device);
      const a11yResult = await a11y.requestSettingsGet(scope, key);
      if (a11yResult.success) {
        const value = a11yResult.found ? (a11yResult.value ?? null) : null;
        if (value === null) {
          return null;
        }
        const trimmed = value.trim();
        return !trimmed || trimmed === "null" ? null : trimmed;
      }
    } catch (error) {
      logger.debug(`[KeepScreenAwake] a11y settings get failed for ${scope}/${key}: ${error}`);
    }
    try {
      const result = await this.adb.executeCommand(`shell settings get ${scope} ${key}`, {
        noRetry: true,
      });
      const trimmed = result.stdout.trim();
      if (!trimmed || trimmed === "null") {
        return null;
      }
      return trimmed;
    } catch (error) {
      logger.warn(
        `[KeepScreenAwake] Failed to read ${scope} ${key} on ${this.device.deviceId}: ${error}`,
      );
      return undefined;
    }
  }

  private async putSetting(
    scope: "global" | "system",
    key: string,
    value: string,
    valueType: "string" | "int" | "long" | "float" = "string",
  ): Promise<void> {
    try {
      const a11y = this.settingsClientProvider(this.device);
      const a11yResult = await a11y.requestSettingsPut(scope, key, value, valueType);
      if (a11yResult.success) {
        return;
      }
    } catch (error) {
      logger.debug(`[KeepScreenAwake] a11y settings put failed for ${scope}/${key}: ${error}`);
    }
    await this.adb.executeCommand(`shell settings put ${scope} ${key} ${value}`);
  }

  private async deleteSetting(scope: "global" | "system", key: string): Promise<void> {
    try {
      const a11y = this.settingsClientProvider(this.device);
      const a11yResult = await a11y.requestSettingsPut(scope, key, null);
      if (a11yResult.success) {
        return;
      }
    } catch (error) {
      logger.debug(`[KeepScreenAwake] a11y settings delete failed for ${scope}/${key}: ${error}`);
    }
    await this.adb.executeCommand(`shell settings delete ${scope} ${key}`);
  }

  private async restoreSetting(
    scope: "global" | "system",
    key: "stay_on_while_plugged_in" | "screen_off_timeout",
    originalValue?: string | null,
    valueType: "int" | "long" = "int",
  ): Promise<KeepScreenAwakeRestoreOutcome> {
    const baselineValue =
      key === "stay_on_while_plugged_in"
        ? DEFAULT_STAY_ON_WHILE_PLUGGED_IN
        : DEFAULT_SCREEN_OFF_TIMEOUT_MS;

    try {
      if (originalValue === null) {
        await this.deleteSetting(scope, key);
      } else {
        await this.putSetting(scope, key, originalValue ?? baselineValue, valueType);
      }
      return originalValue === undefined
        ? { status: "restored_to_baseline", settings: [{ setting: key, value: baselineValue }] }
        : { status: "restored" };
    } catch (error) {
      logger.warn(
        `[KeepScreenAwake] Failed to restore ${scope} ${key} on ${this.device.deviceId}: ${error}`,
      );
      return { status: "failed", failures: [{ setting: key, error: errorMessage(error) }] };
    }
  }
}
