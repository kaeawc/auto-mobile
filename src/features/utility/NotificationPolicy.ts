import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidUserTargetResolver } from "../../utils/android-cmdline-tools/AndroidUserTargetResolver";
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

const POLICY_ACCESS_HEADER = /^\s*(?:mPolicyAccess|policy\s+access)\b/i;
const POLICY_ACCESS_INLINE_MAP = /^\s*mPolicyAccess\s*=\s*\{(.*)\}\s*$/;
const USER_LIST_ENTRY = /(\d+)=\[([^\]]*)\]/g;

/** Per-Android-user list of the package (or `package/Component`) entries granted policy access. */
type PolicyAccessByUser = Map<number, string[]>;

type PolicyAccessParse =
  | { kind: "map"; byUser: PolicyAccessByUser; headerLine: string }
  | { kind: "unrecognised"; reason: string };

/**
 * Recognise exactly one shape: a single line-anchored `mPolicyAccess={<user>=[<entries>], ...}`.
 * Anything else (no header, several header-like lines, a label with children on other lines, a
 * malformed or duplicated map) is "unrecognised" so the caller reports an unverified state rather
 * than a confident but possibly wrong answer.
 */
function parsePolicyAccessMap(output: string): PolicyAccessParse {
  const headers = output.split(/\r?\n/).filter((line) => POLICY_ACCESS_HEADER.test(line));
  if (headers.length === 0) {
    return {
      kind: "unrecognised",
      reason: "Could not find notification policy access state in dumpsys notification output",
    };
  }
  const inline = headers.length === 1 ? POLICY_ACCESS_INLINE_MAP.exec(headers[0]) : null;
  if (!inline) {
    return {
      kind: "unrecognised",
      reason:
        headers.length > 1
          ? "dumpsys notification output has several policy access lines"
          : "dumpsys notification policy access line is not in a recognised format",
    };
  }
  const body = inline[1];
  if (body.replace(USER_LIST_ENTRY, "").replace(/[\s,]/g, "").length > 0) {
    return {
      kind: "unrecognised",
      reason: "dumpsys notification policy access map is not in a recognised format",
    };
  }
  const byUser: PolicyAccessByUser = new Map();
  for (const [, user, list] of body.matchAll(USER_LIST_ENTRY)) {
    const userId = Number.parseInt(user, 10);
    if (byUser.has(userId)) {
      return {
        kind: "unrecognised",
        reason: "dumpsys notification policy access map repeats a user",
      };
    }
    byUser.set(
      userId,
      list
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    );
  }
  return { kind: "map", byUser, headerLine: headers[0].trim() };
}

/**
 * Decide the app's grant from one user's list. An exact package entry is granted; a bare
 * `package/Component` entry is a condition-provider component, not the package grant, so it
 * neither grants nor proves a revoke (null).
 */
function decideForUser(entries: string[], appId: string): boolean | null {
  if (entries.includes(appId)) {
    return true;
  }
  return entries.some((entry) => entry.startsWith(`${appId}/`)) ? null : false;
}

interface CurrentUser {
  userId?: number;
  unavailableReason?: string;
}

/** Resolve the Android user `cmd notification allow_dnd|disallow_dnd` acts on (the current user). */
async function resolveCurrentUser(adb: AdbExecutor): Promise<CurrentUser> {
  try {
    const target = await new AndroidUserTargetResolver(adb).resolve({ currentUser: true });
    return target.source === "currentUser"
      ? { userId: target.userId }
      : { unavailableReason: "the current Android user could not be read" };
  } catch (error) {
    logger.warn(
      `[NotificationPolicy] Failed to resolve the current Android user: ${errorMessage(error)}`,
    );
    return { unavailableReason: "the current Android user could not be resolved" };
  }
}

function decide(
  parsed: PolicyAccessParse,
  appId: string,
  user: CurrentUser,
): Pick<NotificationPolicyAccessState, "allowed" | "rawValue" | "warning"> {
  if (parsed.kind === "unrecognised") {
    return { allowed: null, warning: parsed.reason };
  }
  const rawValue = parsed.headerLine;
  if (parsed.byUser.size === 0) {
    return { allowed: false, rawValue };
  }
  if (user.userId === undefined) {
    const why = user.unavailableReason ?? "current Android user unknown";
    return { allowed: null, rawValue, warning: `Policy access is listed per user but ${why}` };
  }
  const entries = parsed.byUser.get(user.userId);
  if (!entries) {
    return {
      allowed: null,
      rawValue,
      warning: `dumpsys notification lists no policy access entry for Android user ${user.userId}`,
    };
  }
  const allowed = decideForUser(entries, appId);
  return allowed === null
    ? {
        allowed,
        rawValue,
        warning: `dumpsys notification lists only component entries for ${appId}`,
      }
    : { allowed, rawValue };
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
      const parsed = parsePolicyAccessMap(result.stdout);
      const user =
        parsed.kind === "map" && parsed.byUser.size > 0 ? await resolveCurrentUser(adb) : {};
      const policyAccess: NotificationPolicyAccessState = {
        supported: true,
        method: "android_dumpsys_notification",
        ...decide(parsed, appId, user),
      };
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
    const commandError = command.error ?? "cmd notification failed";
    // A conclusive read-back that already equals the request means the desired state holds.
    return allowed === input.policyAccess
      ? {
          warning: `cmd notification reported an error but the requested state holds: ${commandError}`,
        }
      : { error: commandError };
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
