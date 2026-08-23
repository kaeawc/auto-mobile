import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import type { SystemConfigurationAdapter } from "../../utils/interfaces/SystemConfigurationAdapter";
import { createSystemConfigurationAdapter } from "./system-configuration/createSystemConfigurationAdapter";
import { buildAppleLanguages, isIosSimulator } from "./system-configuration/iosHelpers";
import {
  BootedDevice,
  GetCalendarSystemResult,
  LocalizationSettingsResult,
  Set24HourFormatResult,
  SetCalendarSystemResult,
  SetLocaleResult,
  SetTextDirectionResult,
  SetTimeZoneResult,
} from "../../models";

const SPRINGBOARD_POLL_INTERVAL_MS = 500;
const SPRINGBOARD_MAX_RETRIES = 10;
const BUNDLE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*)+$/;

export interface ApplyLiveChangesResult {
  springBoardRestarted: boolean;
  notificationPosted: boolean;
  appRestarted?: boolean;
}

export class SystemConfigurationManager {
  private device: BootedDevice;
  private processExecutor: HostCommandExecutor;
  private timer: Timer;
  private readonly adapter: SystemConfigurationAdapter;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    processExecutor: HostCommandExecutor = new DefaultHostCommandExecutor(),
    timer: Timer = defaultTimer,
  ) {
    this.device = device;
    this.processExecutor = processExecutor;
    this.timer = timer;
    this.adapter = createSystemConfigurationAdapter(
      device,
      adbFactory.create(device),
      processExecutor,
    );
  }

  async setLocale(
    languageTag: string,
    options: { broadcast?: boolean; appId?: string } = {},
  ): Promise<SetLocaleResult> {
    const trimmedTag = languageTag.trim();
    if (!trimmedTag) {
      return {
        success: false,
        languageTag,
        error: "languageTag must be a non-empty string",
      };
    }
    return this.adapter.setLocale(trimmedTag, options);
  }

  async setTimeZone(zoneId: string): Promise<SetTimeZoneResult> {
    const trimmedZone = zoneId.trim();
    if (!trimmedZone) {
      return {
        success: false,
        zoneId,
        error: "zoneId must be a non-empty string",
      };
    }
    return this.adapter.setTimeZone(trimmedZone);
  }

  async setTextDirection(
    rtl: boolean,
    options: { broadcast?: boolean } = {},
  ): Promise<SetTextDirectionResult> {
    return this.adapter.setTextDirection(rtl, options);
  }

  async broadcastLocaleChange(): Promise<boolean> {
    return this.adapter.broadcastLocaleChange();
  }

  async set24HourFormat(enabled: boolean): Promise<Set24HourFormatResult> {
    return this.adapter.set24HourFormat(enabled);
  }

  async setCalendarSystem(calendarSystem: string): Promise<SetCalendarSystemResult> {
    const trimmed = calendarSystem.trim();
    if (!trimmed) {
      return {
        success: false,
        calendarSystem,
        error: "calendarSystem must be a non-empty string",
      };
    }
    return this.adapter.setCalendarSystem(trimmed);
  }

  async getCalendarSystem(): Promise<GetCalendarSystemResult> {
    return this.adapter.getCalendarSystem();
  }

  async getLocalizationSettings(): Promise<LocalizationSettingsResult> {
    return this.adapter.getLocalizationSettings();
  }

  // --- iOS Simulator-only public methods ---

  /** Build Apple's fallback language chain for the AppleLanguages defaults key. */
  buildAppleLanguages(languageTag: string): string[] {
    return buildAppleLanguages(languageTag);
  }

  async restartSpringBoard(): Promise<boolean> {
    if (!isIosSimulator(this.device.deviceId)) {
      return false;
    }

    try {
      await this.processExecutor.executeCommand("xcrun", [
        "simctl",
        "spawn",
        this.device.deviceId,
        "launchctl",
        "stop",
        "com.apple.SpringBoard",
      ]);
    } catch (error) {
      logger.warn(`[SystemConfigurationManager] Failed to stop SpringBoard: ${error}`);
      return false;
    }

    for (let i = 0; i < SPRINGBOARD_MAX_RETRIES; i++) {
      await this.timer.sleep(SPRINGBOARD_POLL_INTERVAL_MS);
      try {
        const result = await this.processExecutor.executeCommand("xcrun", [
          "simctl",
          "spawn",
          this.device.deviceId,
          "launchctl",
          "list",
          "com.apple.SpringBoard",
        ]);
        if (result.stdout && result.stdout.includes("SpringBoard")) {
          return true;
        }
      } catch {
        // SpringBoard not yet restarted, continue polling
      }
    }

    logger.warn("[SystemConfigurationManager] SpringBoard did not restart within timeout");
    return false;
  }

  async postLocaleChangeNotification(): Promise<boolean> {
    if (!isIosSimulator(this.device.deviceId)) {
      return false;
    }

    try {
      await this.processExecutor.executeCommand("xcrun", [
        "simctl",
        "spawn",
        this.device.deviceId,
        "notifyutil",
        "-p",
        "com.apple.language.changed",
      ]);
      return true;
    } catch (error) {
      logger.warn(`[SystemConfigurationManager] Failed to post locale notification: ${error}`);
      return false;
    }
  }

  async applyIosLiveChanges(restartAppBundleId?: string): Promise<ApplyLiveChangesResult> {
    const simulator = isIosSimulator(this.device.deviceId);
    const springBoardRestarted = await this.restartSpringBoard();
    const notificationPosted = await this.postLocaleChangeNotification();

    const result: ApplyLiveChangesResult = {
      springBoardRestarted,
      notificationPosted,
    };

    if (restartAppBundleId) {
      if (!BUNDLE_ID_PATTERN.test(restartAppBundleId)) {
        logger.warn(`[SystemConfigurationManager] Invalid bundle ID: ${restartAppBundleId}`);
        result.appRestarted = false;
      } else if (!simulator) {
        logger.warn(
          "[SystemConfigurationManager] iOS app restart after localization is only supported on simulators",
        );
        result.appRestarted = false;
      } else {
        try {
          await this.processExecutor.executeCommand("xcrun", [
            "simctl",
            "terminate",
            this.device.deviceId,
            restartAppBundleId,
          ]);
          await this.timer.sleep(SPRINGBOARD_POLL_INTERVAL_MS);
          await this.processExecutor.executeCommand("xcrun", [
            "simctl",
            "launch",
            this.device.deviceId,
            restartAppBundleId,
          ]);
          result.appRestarted = true;
        } catch (error) {
          logger.warn(
            `[SystemConfigurationManager] Failed to restart app ${restartAppBundleId}: ${error}`,
          );
          result.appRestarted = false;
        }
      }
    }

    return result;
  }
}
