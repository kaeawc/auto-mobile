import type { BootedDevice } from "../models";
import { classifyAndroidUser } from "../models/AndroidUser";
import type { DeviceBaseline, MutationValue } from "../daemon/sessionBroker/mutations/types";
import { observableMutationValue as present } from "../daemon/sessionBroker/mutations/types";
import { baselineHoldsApp } from "../daemon/sessionBroker/mutations/appInventory";
import { parseAndroidRuntimePermissions } from "../features/action/parseAndroidRuntimePermissions";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { DUMPSYS_MAX_BUFFER } from "../utils/android-cmdline-tools/dumpsysLimits";
import { readAndroidDeviceApiLevel } from "../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { outputLooksLikeShellFailure } from "../utils/android-cmdline-tools/shellOutputHeuristics";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { shellQuote } from "../utils/shellQuote";
import type { ToolMutation } from "./deviceMutationAdapters";
import type { MutationPriorReader } from "./deviceMutationPriorReader";

/**
 * The Android user a `setAppPermissions` call acts on, and whether its `notificationsEnabled`
 * toggles the POST_NOTIFICATIONS runtime permission (API 33+) rather than an app-op.
 */
export interface AndroidPermissionTarget {
  userId: number;
  notificationsAreRuntime: boolean;
}

export type AndroidPermissionTargetAdb = Pick<AdbExecutor, "executeCommand" | "listUsers">;

const RUNTIME_PERMISSION_KEY =
  /^runtime:(\d+):([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*):([A-Za-z0-9_.]+)$/;

/** `runtime:<user>:<package>:<permission>`, the key the Android reset port reverts in place. */
export function parseRuntimePermissionKey(
  key: string,
): { userId: number; appId: string; permission: string } | undefined {
  const match = RUNTIME_PERMISSION_KEY.exec(key);
  return match ? { userId: Number(match[1]), appId: match[2]!, permission: match[3]! } : undefined;
}

/**
 * The user the tool will resolve without an explicit `userId`, only when that choice cannot
 * depend on the foreground app: exactly one running user, and it is the primary user.
 */
async function soleRunningPrimaryUser(
  adb: AndroidPermissionTargetAdb,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const running = (await adb.listUsers(signal)).filter((user) => user.running);
  const sole = running.length === 1 ? running[0]! : undefined;
  return sole && (sole.profileType ?? classifyAndroidUser(sole.flags)) === "primary"
    ? sole.userId
    : undefined;
}

/**
 * Resolves the target of an Android `setAppPermissions` call the same way the tool does, or
 * undefined when the tool's choice is not certain (device-wide reset, an ambiguous user, an
 * unreadable API level for the notification toggle), so the call keeps its escalating rows.
 */
export async function readAndroidPermissionTarget(
  adb: AndroidPermissionTargetAdb,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  readApiLevel: typeof readAndroidDeviceApiLevel = readAndroidDeviceApiLevel,
): Promise<AndroidPermissionTarget | undefined> {
  if (args.action === "reset") {
    return undefined;
  }
  const explicit =
    typeof args.userId === "number" && Number.isSafeInteger(args.userId) && args.userId >= 0
      ? args.userId
      : undefined;
  const userId = args.userId === undefined ? await soleRunningPrimaryUser(adb, signal) : explicit;
  if (userId === undefined) {
    return undefined;
  }
  // The tool treats an unreadable API level as 33+, so only a level read now proves the path.
  const apiLevel =
    args.notificationsEnabled === undefined
      ? null
      : await readApiLevel(adb, undefined, undefined, signal);
  return { userId, notificationsAreRuntime: apiLevel !== null && apiLevel >= 33 };
}

function runtimePrior(
  dump: string | undefined,
  target: { userId: number; appId: string; permission: string },
): MutationValue {
  const state =
    dump === undefined
      ? undefined
      : parseAndroidRuntimePermissions(dump, target.appId, target.userId)?.runtimePermissions.get(
          target.permission,
        )?.state;
  return state === "granted" || state === "denied"
    ? present(state === "granted")
    : { state: "unobservable" };
}

/** Reads the grant of each `runtime:` permission intent from `dumpsys package`. */
export class PermissionMutationPriorReader implements MutationPriorReader {
  constructor(
    private readonly adbFor: (device: BootedDevice) => Pick<AdbExecutor, "executeCommand"> = (
      device,
    ) => defaultAdbClientFactory.create(device),
  ) {}

  async read(
    device: BootedDevice,
    mutations: readonly ToolMutation[],
    signal?: AbortSignal,
  ): Promise<readonly MutationValue[]> {
    const targets = mutations.map((entry) =>
      device.platform === "android" && entry.kind === "permission"
        ? parseRuntimePermissionKey(entry.key)
        : undefined,
    );
    const packages = [...new Set(targets.flatMap((target) => (target ? [target.appId] : [])))];
    const dumps = new Map<string, string | undefined>();
    if (packages.length > 0) {
      const adb = this.adbFor(device);
      for (const appId of packages) {
        dumps.set(appId, await this.readDump(adb, appId, signal));
      }
    }
    return targets.map((target) =>
      target ? runtimePrior(dumps.get(target.appId), target) : { state: "unobservable" },
    );
  }

  private async readDump(
    adb: Pick<AdbExecutor, "executeCommand">,
    appId: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const result = await adb.executeCommand(`shell dumpsys package ${shellQuote(appId)}`, {
        maxBuffer: DUMPSYS_MAX_BUFFER,
        noRetry: true,
        signal,
      });
      if (outputLooksLikeShellFailure(result.stdout, result.stderr ?? "")) {
        logger.warn(`Cannot read runtime permissions of ${appId}; recording unobservable priors`);
        return undefined;
      }
      return result.stdout;
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `Cannot read runtime permissions of ${appId}; recording unobservable priors: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }
}

/**
 * Drops `runtime:` permission intents on a package the baseline never held: the keep-booted
 * clean uninstalls such a package, which removes its permission state, so the intent needs no
 * revert (and a revert after the session uninstalled it would fail). An unreadable baseline
 * keeps every intent.
 */
export function withoutBaselineCoveredPermissions<Mutation extends ToolMutation>(
  mutations: readonly Mutation[],
  baseline: DeviceBaseline | null | undefined,
): Mutation[] {
  return mutations.filter((mutation) => {
    const target = mutation.kind === "permission" ? parseRuntimePermissionKey(mutation.key) : null;
    return !target || !baseline || baselineHoldsApp(baseline, target.appId);
  });
}
