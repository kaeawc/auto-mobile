import { defaultAdbClientFactory, type AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BootedDevice } from "../../models";
import { SetAndroidNotificationPolicyAccess } from "../action/SetAndroidNotificationPolicyAccess";

export interface NotificationPolicyAccessState {
  supported: boolean;
  allowed?: boolean | null;
  method?: "android_cmd_notification" | "android_dumpsys_notification" | "unsupported";
  rawValue?: string;
  warning?: string;
  error?: string;
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
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseAndroidPolicyAccess(output: string, appId: string): NotificationPolicyAccessState {
  const policyAccessLine = output
    .split(/\r?\n/)
    .find(line => /mPolicyAccess|policy\s+access/i.test(line) && line.includes(appId));

  if (policyAccessLine) {
    const appPattern = new RegExp(`(^|[^A-Za-z0-9_.])${escapeRegExp(appId)}([^A-Za-z0-9_.]|$)`);
    return {
      supported: true,
      allowed: appPattern.test(policyAccessLine),
      method: "android_dumpsys_notification",
      rawValue: policyAccessLine.trim(),
    };
  }

  if (/mPolicyAccess|policy\s+access/i.test(output)) {
    return {
      supported: true,
      allowed: false,
      method: "android_dumpsys_notification",
    };
  }

  return {
    supported: true,
    allowed: null,
    method: "android_dumpsys_notification",
    warning: "Could not find notification policy access state in dumpsys notification output",
  };
}

export class NotificationPolicy {
  private device: BootedDevice;

  private adbFactory: AdbClientFactory;

  constructor(device: BootedDevice, dependencies: NotificationPolicyDependencies = {}) {
    this.device = device;
    this.adbFactory = dependencies.adbFactory ?? defaultAdbClientFactory;
  }

  async getPolicy(appId: string): Promise<NotificationPolicyResult> {
    if (this.device.platform !== "android") {
      const error = "iOS does not expose app notification policy access for simulators or physical devices";
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
      const result = await adb.executeCommand("shell dumpsys notification", undefined, undefined, true);
      const policyAccess = parseAndroidPolicyAccess(result.stdout ?? "", appId);
      return {
        success: !policyAccess.error,
        appId,
        deviceId: this.device.deviceId,
        platform: this.device.platform,
        policyAccess,
        ...(policyAccess.error ? { error: policyAccess.error } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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

  async setPolicy(appId: string, input: SetNotificationPolicyInput): Promise<NotificationPolicyResult> {
    if (this.device.platform !== "android") {
      const error = "iOS does not expose app notification policy access for simulators or physical devices";
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

    const result = await new SetAndroidNotificationPolicyAccess(this.device, this.adbFactory).execute(appId, {
      allowed: input.policyAccess,
    });

    return {
      success: result.success,
      appId,
      deviceId: this.device.deviceId,
      platform: this.device.platform,
      policyAccess: {
        supported: true,
        allowed: input.policyAccess,
        method: "android_cmd_notification",
        ...(result.error ? { error: result.error } : {}),
      },
      ...(result.error ? { error: result.error } : {}),
    };
  }
}
