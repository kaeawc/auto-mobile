import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { AndroidDeviceShellToolResult, BootedDevice } from "../../models";
import { SetAndroidNotificationPolicyAccess } from "../action/SetAndroidNotificationPolicyAccess";
import {
  defaultBulletinBoardReader,
  type IosNotificationAuthorizationReader,
} from "./ios/IosNotificationAuthorizationReader";

export interface NotificationPolicyAccessState {
  supported: boolean;
  allowed?: boolean | null;
  method?:
    | "android_cmd_notification"
    | "android_dumpsys_notification"
    | "ios_bulletinboard_plist"
    | "unsupported";
  rawValue?: string;
  warning?: string;
  error?: string;
  // iOS-only enrichment (all optional so the Android shape is unchanged):
  authorizationStatus?: "notDetermined" | "denied" | "authorized" | "provisional" | "ephemeral";
  lockScreen?: boolean;
  notificationCenter?: boolean;
  alerts?: boolean;
}

export interface NotificationPolicyResult {
  success: boolean;
  appId: string;
  deviceId: string;
  platform: "android" | "ios";
  policyAccess: NotificationPolicyAccessState;
  error?: string;
}

export interface SetNotificationPolicyInput {
  policyAccess: boolean;
}

export interface NotificationPolicyDependencies {
  adbFactory?: AdbClientFactory;
  iosReader?: IosNotificationAuthorizationReader;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectPolicyAccessSection(
  lines: string[],
): { headerIdx: number; sectionLines: string[] } | null {
  const headerRe = /mPolicyAccess|policy\s+access/i;
  for (let i = 0; i < lines.length; i++) {
    if (!headerRe.test(lines[i])) {
      continue;
    }
    const headerIndent = lines[i].match(/^\s*/)![0].length;
    const sectionLines: string[] = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim().length === 0) {
        continue;
      }
      const indent = line.match(/^\s*/)![0].length;
      if (indent <= headerIndent) {
        break;
      }
      sectionLines.push(line);
    }
    return { headerIdx: i, sectionLines };
  }
  return null;
}

function parseAndroidPolicyAccess(output: string, appId: string): NotificationPolicyAccessState {
  const lines = output.split(/\r?\n/);
  const section = collectPolicyAccessSection(lines);

  if (!section) {
    return {
      supported: true,
      allowed: null,
      method: "android_dumpsys_notification",
      warning: "Could not find notification policy access state in dumpsys notification output",
    };
  }

  const sectionText = section.sectionLines.join("\n");
  const appPattern = new RegExp(`(^|[^A-Za-z0-9_.])${escapeRegExp(appId)}([^A-Za-z0-9_.]|$)`);
  const allowed = appPattern.test(sectionText);
  const matchLine = section.sectionLines.find((line) => appPattern.test(line));
  return {
    supported: true,
    allowed,
    method: "android_dumpsys_notification",
    rawValue: (matchLine ?? section.sectionLines[0]).trim(),
  };
}

export class NotificationPolicy {
  private device: BootedDevice;

  private adbFactory: AdbClientFactory;

  private iosReader?: IosNotificationAuthorizationReader;

  constructor(device: BootedDevice, dependencies: NotificationPolicyDependencies = {}) {
    this.device = device;
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
    this.iosReader = dependencies.iosReader;
  }

  async getPolicy(appId: string): Promise<NotificationPolicyResult> {
    if (this.device.platform === "ios") {
      const reader = this.iosReader ?? defaultBulletinBoardReader();
      const policyAccess = await reader.read(this.device.deviceId, appId);
      return {
        success: !policyAccess.error,
        appId,
        deviceId: this.device.deviceId,
        platform: "ios",
        policyAccess,
        ...(policyAccess.error ? { error: policyAccess.error } : {}),
      };
    }

    if (this.device.platform !== "android") {
      const error =
        "iOS does not expose app notification policy access for simulators or physical devices";
      return {
        success: false,
        appId,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        policyAccess: {
          supported: false,
          method: "unsupported",
          error,
        },
        error,
      };
    }

    try {
      const adb: AdbExecutor = this.adbFactory.create(this.device);
      const result = await adb.executeCommand(
        "shell dumpsys notification",
        undefined,
        undefined,
        true,
      );
      const policyAccess = parseAndroidPolicyAccess(result.stdout, appId);
      return {
        success: !policyAccess.error,
        appId,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        policyAccess,
        ...(policyAccess.error ? { error: policyAccess.error } : {}),
      };
    } catch (error) {
      const message = errorMessage(error);
      logger.warn(`[NotificationPolicy] Failed to read Android notification policy: ${message}`);
      return {
        success: false,
        appId,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        policyAccess: {
          supported: true,
          method: "android_dumpsys_notification",
          error: message,
        },
        error: message,
      };
    }
  }

  async setPolicy(
    appId: string,
    input: SetNotificationPolicyInput,
  ): Promise<NotificationPolicyResult> {
    if (this.device.platform !== "android") {
      const error =
        "iOS does not expose app notification policy access for simulators or physical devices";
      return {
        success: false,
        appId,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        policyAccess: {
          supported: false,
          allowed: null,
          method: "unsupported",
          error,
        },
        error,
      };
    }

    const result = await new SetAndroidNotificationPolicyAccess(
      this.device,
      this.adbFactory,
    ).execute(appId, {
      allowed: input.policyAccess,
    });

    // Never echo the request: read the policy-access state back (one extra
    // `shell dumpsys notification`) and report what the device now says.
    const observed = await this.getPolicy(appId);
    return this.buildSetResult(appId, input, result, observed);
  }

  private buildSetResult(
    appId: string,
    input: SetNotificationPolicyInput,
    command: AndroidDeviceShellToolResult,
    observed: NotificationPolicyResult,
  ): NotificationPolicyResult {
    const base = { appId, deviceId: this.device.deviceId, platform: this.device.platform };
    const readBack = observed.policyAccess;
    const allowed = observed.success ? (readBack.allowed ?? null) : null;
    const policyAccess: NotificationPolicyAccessState = {
      supported: true,
      allowed,
      method: observed.success ? "android_dumpsys_notification" : "android_cmd_notification",
      ...(readBack.rawValue ? { rawValue: readBack.rawValue } : {}),
    };

    const verdict = classifySetOutcome(appId, input, command, allowed, readBack);
    if (verdict.error) {
      const { error } = verdict;
      return { ...base, success: false, policyAccess: { ...policyAccess, error }, error };
    }
    return {
      ...base,
      success: true,
      policyAccess: verdict.warning ? { ...policyAccess, warning: verdict.warning } : policyAccess,
    };
  }
}

/** Compare the command outcome and the read-back with the request; error means failure. */
function classifySetOutcome(
  appId: string,
  input: SetNotificationPolicyInput,
  command: AndroidDeviceShellToolResult,
  allowed: boolean | null,
  readBack: NotificationPolicyAccessState,
): { error?: string; warning?: string } {
  if (!command.success) {
    return { error: command.error ?? "cmd notification failed" };
  }
  if (allowed === null) {
    const reason = readBack.error ?? readBack.warning ?? "state could not be determined";
    return {
      warning: `Command succeeded but the resulting policy access was not verified: ${reason}`,
    };
  }
  if (allowed !== input.policyAccess) {
    const sub = input.policyAccess ? "allow_dnd" : "disallow_dnd";
    return {
      error: `cmd notification ${sub} reported success but dumpsys notification shows policy access ${allowed ? "still granted" : "not granted"} for ${appId}`,
    };
  }
  return {};
}
