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

const ALLOWED_PROVIDERS_HEADER = /^\s*Allowed condition providers:\s*$/;
const ALLOWED_PROVIDERS_LINE = /^\s+(.*?)\s*\(user: (\d+) isPrimary: (true|false)\)\s*$/;

/** One Android user's approved condition-provider lists, split by the dump's `isPrimary` flag. */
interface UserProviderLists {
  primary?: string[];
  other: string[];
}

type PolicyAccessByUser = Map<number, UserProviderLists>;

type PolicyAccessParse =
  | { kind: "providers"; byUser: PolicyAccessByUser }
  | { kind: "unrecognised"; reason: string };

function splitEntries(items: string): string[] {
  return items.split(":").filter((entry) => entry.length > 0);
}

/**
 * Recognise the shape `cmd notification allow_dnd|disallow_dnd` actually changes (captured on API 36
 * emulators): under `Allowed condition providers:` (the ConditionProviders ManagedServices dump) each
 * `(user, isPrimary)` pair prints one line, `<entry>:<entry>:... (user: N isPrimary: true|false)`,
 * where an entry is a bare package or `package/Component`. `allow_dnd <pkg>` adds the bare package
 * to the primary list; `disallow_dnd` removes it. `dumpsys notification` has no
 * `mPolicyAccess` line (an earlier revision parsed one and so reported `allowed: null` everywhere).
 * The separate `Has user set:` block is not a grant (it still names a package after a revoke) and is
 * ignored. A missing, repeated or unparseable block is "unrecognised" so the caller reports an
 * unverified state rather than a confident but possibly wrong answer.
 */
function parsePolicyAccess(output: string): PolicyAccessParse {
  const lines = output.split(/\r?\n/);
  const headers = lines.flatMap((line, index) =>
    ALLOWED_PROVIDERS_HEADER.test(line) ? [index] : [],
  );
  if (headers.length !== 1) {
    return {
      kind: "unrecognised",
      reason:
        headers.length === 0
          ? "Could not find the allowed condition providers list in dumpsys notification output"
          : "dumpsys notification output has several allowed condition providers lists",
    };
  }
  const byUser: PolicyAccessByUser = new Map();
  for (const line of lines.slice(headers[0] + 1)) {
    const match = ALLOWED_PROVIDERS_LINE.exec(line);
    if (!match) {
      break;
    }
    const userId = Number.parseInt(match[2], 10);
    const lists = byUser.get(userId) ?? { other: [] };
    const entries = splitEntries(match[1]);
    if (match[3] === "false") {
      lists.other.push(...entries);
    } else if (lists.primary) {
      return {
        kind: "unrecognised",
        reason: "dumpsys notification repeats a user's primary allowed condition providers list",
      };
    } else {
      lists.primary = entries;
    }
    byUser.set(userId, lists);
  }
  return byUser.size === 0
    ? {
        kind: "unrecognised",
        reason: "dumpsys notification allowed condition providers list has no recognised entries",
      }
    : { kind: "providers", byUser };
}

/**
 * Decide the app's grant from one user's lists. The bare package in the primary list is the grant.
 * A `package/Component` entry is a condition-provider component, not the package grant, and a bare
 * package only in the non-primary list is not what `allow_dnd` writes, so neither grants nor proves
 * a revoke (null). A user with no primary list is unverified.
 */
function decideForUser(lists: UserProviderLists, appId: string): boolean | null {
  if (!lists.primary) {
    return null;
  }
  if (lists.primary.includes(appId)) {
    return true;
  }
  const mentioned = [...lists.primary, ...lists.other].some(
    (entry) => entry === appId || entry.startsWith(`${appId}/`),
  );
  return mentioned ? null : false;
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
): Pick<NotificationPolicyAccessState, "allowed" | "warning"> {
  if (parsed.kind === "unrecognised") {
    return { allowed: null, warning: parsed.reason };
  }
  if (user.userId === undefined) {
    const why = user.unavailableReason ?? "current Android user unknown";
    return { allowed: null, warning: `Policy access is listed per user but ${why}` };
  }
  const lists = parsed.byUser.get(user.userId);
  if (!lists) {
    return {
      allowed: null,
      warning: `dumpsys notification lists no allowed condition providers for Android user ${user.userId}`,
    };
  }
  const allowed = decideForUser(lists, appId);
  return allowed === null
    ? { allowed, warning: `dumpsys notification does not conclusively list ${appId} for the user` }
    : { allowed };
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
      const parsed = parsePolicyAccess(result.stdout);
      const user = parsed.kind === "providers" ? await resolveCurrentUser(adb) : {};
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
