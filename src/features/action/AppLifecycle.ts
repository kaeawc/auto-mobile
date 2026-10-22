import type {
  AppLifecycleAction,
  AppLifecycleResult,
  AppTrimMemoryLevel,
  BootedDevice,
} from "../../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import {
  findAndroidPackageProcessId,
  readAndroidPackageProcesses,
  selectAndroidUserId,
} from "../../utils/android-cmdline-tools/androidProcessState";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../../utils/androidPackageName";
import { fixedBackoff } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { HomeScreen } from "./HomeScreen";
import {
  DefaultDeviceWindowCacheInvalidator,
  type DeviceWindowCacheInvalidator,
} from "./TerminateApp";

const RECLAIM_POLL_BUDGET_MS = 5_000;
const RECLAIM_POLL_INTERVAL_MS = 250;
const COMMAND_TIMEOUT_MS = 5_000;

/** Narrow Home seam: the production path retains HomeScreen's launcher verification. */
export interface AppLifecycleHome {
  execute(signal?: AbortSignal): Promise<void>;
}
export interface AppLifecycleDependencies {
  adb?: AdbExecutor;
  adbFactory?: AdbClientFactory;
  timer?: Timer;
  home?: AppLifecycleHome;
  cacheInvalidator?: DeviceWindowCacheInvalidator;
}
export interface AppLifecycleExecutionOptions {
  signal?: AbortSignal;
  /** Called immediately before a mutating operation, including one that later fails. */
  onMutation?: () => void;
  /** `onTrimMemory` level for the trimMemory action; required for it and rejected for the others. */
  trimLevel?: AppTrimMemoryLevel;
}

/** `am send-trim-memory` level names; the shell calls `TRIM_MEMORY_UI_HIDDEN` HIDDEN. */
const TRIM_LEVEL_ARGUMENT: Readonly<Record<AppTrimMemoryLevel, string>> = {
  RUNNING_MODERATE: "RUNNING_MODERATE",
  RUNNING_LOW: "RUNNING_LOW",
  RUNNING_CRITICAL: "RUNNING_CRITICAL",
  UI_HIDDEN: "HIDDEN",
  BACKGROUND: "BACKGROUND",
  MODERATE: "MODERATE",
  COMPLETE: "COMPLETE",
};
const TRIM_FAILURE_OUTPUT = /error|exception|unknown|not found|no such|failed/i;
const MECHANISMS = {
  background: "home",
  killBackgrounded: "am-kill",
  trimMemory: "am-send-trim-memory",
} as const;
interface AndroidLifecycleTarget {
  base: AppLifecycleResult;
  userId: number;
  pidBefore: number;
}

/** trimMemory needs a level and no other action takes one; null when the combination is valid. */
function trimArgumentError(
  base: AppLifecycleResult,
  action: AppLifecycleAction,
  level: AppTrimMemoryLevel | undefined,
): AppLifecycleResult | null {
  if (action === "trimMemory" && level === undefined) {
    return {
      ...base,
      errorCode: "trim_level_required",
      error: "trimMemory needs a level, e.g. COMPLETE or RUNNING_CRITICAL",
    };
  }
  if (action !== "trimMemory" && level !== undefined) {
    return {
      ...base,
      errorCode: "trim_level_not_applicable",
      error: `level only applies to the trimMemory action, not ${action}`,
    };
  }
  return null;
}

export class AppLifecycle {
  private readonly adb: AdbExecutor;
  private readonly timer: Timer;
  private readonly home: AppLifecycleHome;
  private readonly cacheInvalidator: DeviceWindowCacheInvalidator;

  constructor(
    private readonly device: BootedDevice,
    dependencies: AppLifecycleDependencies = {},
  ) {
    this.adb =
      dependencies.adb ?? (dependencies.adbFactory ?? defaultAdbClientFactory).create(device);
    this.timer = dependencies.timer ?? defaultTimer;
    this.home = dependencies.home ?? {
      execute: async (signal) => {
        await new HomeScreen(device, null, this.timer).execute({ signal });
      },
    };
    this.cacheInvalidator =
      dependencies.cacheInvalidator ?? new DefaultDeviceWindowCacheInvalidator();
  }

  async execute(
    appId: string,
    action: AppLifecycleAction,
    options: AppLifecycleExecutionOptions = {},
  ): Promise<AppLifecycleResult> {
    const { signal } = options;
    signal?.throwIfAborted();
    const base = this.initialResult(appId, action, options.trimLevel);
    const refused = this.preflightRefusal(base, action, options);
    if (refused) {
      return refused;
    }
    const { processes } = await readAndroidPackageProcesses(this.adb, appId, {
      signal,
      timer: this.timer,
    });
    signal?.throwIfAborted();
    if (processes.length === 0) {
      return { ...base, errorCode: "app_not_running", error: `${appId} is not running` };
    }
    const userId = await selectAndroidUserId(this.adb, appId, processes, {
      signal,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    signal?.throwIfAborted();
    if (userId === null) {
      return {
        ...base,
        errorCode: "ambiguous_user",
        error: `${appId} is running under multiple Android users; foreground identity is ambiguous`,
      };
    }
    const pidBefore = findAndroidPackageProcessId(processes, appId, userId);
    if (pidBefore === null) {
      return { ...base, userId, errorCode: "app_not_running", error: `${appId} is not running` };
    }
    const target = { base: { ...base, userId }, userId, pidBefore };
    if (action === "trimMemory" && options.trimLevel) {
      return this.trimMemory(target, options.trimLevel, signal);
    }
    return action === "background"
      ? this.background(target, options)
      : this.killBackgrounded(target, options);
  }

  /**
   * `am send-trim-memory` delivers `onTrimMemory(level)` to a running app without killing it. It
   * prints nothing on success; the app's reaction is visible in its own logs (`getLogs`).
   */
  private async trimMemory(
    target: AndroidLifecycleTarget,
    level: AppTrimMemoryLevel,
    signal?: AbortSignal,
  ): Promise<AppLifecycleResult> {
    const { base, userId, pidBefore } = target;
    const attempt = { ...base, pidBefore, trimLevel: level };
    let output: string;
    try {
      const result = await this.adb.executeCommand(
        `shell am send-trim-memory --user ${userId} ${shellQuote(base.appId)} ${TRIM_LEVEL_ARGUMENT[level]}`,
        { timeoutMs: COMMAND_TIMEOUT_MS, noRetry: true, signal },
      );
      output = `${result.stdout}\n${result.stderr}`.trim();
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[AppLifecycle] Android trim-memory command failed for ${base.appId}`, error);
      return { ...attempt, errorCode: "trim_failed", error: errorMessage(error) };
    }
    if (TRIM_FAILURE_OUTPUT.test(output)) {
      return { ...attempt, errorCode: "trim_failed", error: output };
    }
    return {
      ...attempt,
      success: true,
      pid: pidBefore,
      message: `Sent onTrimMemory(${level}) to ${base.appId} (pid ${pidBefore}); read its logs to see how it reacted`,
    };
  }

  private initialResult(
    appId: string,
    action: AppLifecycleAction,
    trimLevel: AppTrimMemoryLevel | undefined,
  ): AppLifecycleResult {
    return {
      success: false,
      supported: this.device.platform === "android",
      action,
      platform: this.device.platform,
      appId,
      mechanism: MECHANISMS[action],
      ...(trimLevel === undefined ? {} : { trimLevel }),
    };
  }

  /** Refusals that need no device command: platform, package name and trim arguments. */
  private preflightRefusal(
    base: AppLifecycleResult,
    action: AppLifecycleAction,
    options: AppLifecycleExecutionOptions,
  ): AppLifecycleResult | null {
    const { appId } = base;
    if (this.device.platform === "ios") {
      // D23 makes BOTH actions unsupported: no verified iOS PID/state-preserving termination contract.
      return {
        ...base,
        mechanism: "unsupported",
        error:
          action === "trimMemory"
            ? "iOS has no onTrimMemory equivalent to send"
            : "No verified state-preserving termination mechanism on iOS; use homeScreen for Home or terminateApp for force-stop",
      };
    }
    if (!ANDROID_PACKAGE_NAME_PATTERN.test(appId)) {
      return {
        ...base,
        errorCode: "invalid_app_id",
        error: `${appId} is not a valid Android package name`,
      };
    }
    return trimArgumentError(base, action, options.trimLevel);
  }

  private async isForeground(
    appId: string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<{ state: "foreground" | "not-foreground" } | { state: "unreadable"; error: string }> {
    const result = await this.adb.getForegroundAppChecked(signal, COMMAND_TIMEOUT_MS);
    signal?.throwIfAborted();
    if (result.state === "unreadable") {
      return result;
    }
    const foreground = result.app;
    return {
      state:
        foreground?.packageName === appId && foreground.userId === userId
          ? "foreground"
          : "not-foreground",
    };
  }

  private async background(
    target: AndroidLifecycleTarget,
    options: AppLifecycleExecutionOptions,
  ): Promise<AppLifecycleResult> {
    const { base, userId, pidBefore } = target;
    const { signal } = options;
    const before = await this.isForeground(base.appId, userId, signal);
    // An unreadable pre-Home state may still be foreground, so Home may be needed.
    const pressedHome = before.state !== "not-foreground";
    if (pressedHome) {
      signal?.throwIfAborted();
      options.onMutation?.();
      try {
        await this.home.execute(signal);
      } finally {
        this.cacheInvalidator.invalidate(this.device);
      }
    }
    const after = await this.isForeground(base.appId, userId, signal);
    if (after.state === "unreadable") {
      return {
        ...base,
        pidBefore,
        errorCode: "background_not_verified",
        error: `Background outcome is indeterminate: ${pressedHome ? `Home was pressed for ${base.appId} but its` : `${base.appId}'s`} foreground state could not be read (${after.error}); background could not be verified. Do not retry automatically.`,
      };
    }
    if (after.state === "foreground") {
      return {
        ...base,
        pidBefore,
        errorCode: "background_not_verified",
        error: `${base.appId} is still foreground; background could not be verified`,
      };
    }
    return { ...base, success: true, pid: pidBefore };
  }

  private async killBackgrounded(
    target: AndroidLifecycleTarget,
    options: AppLifecycleExecutionOptions,
  ): Promise<AppLifecycleResult> {
    const { base, userId, pidBefore } = target;
    const { signal } = options;
    const attempt = { ...base, pidBefore };
    const foreground = await this.isForeground(base.appId, userId, signal);
    if (foreground.state === "unreadable") {
      return {
        ...attempt,
        errorCode: "background_not_verified",
        error: `Cannot kill ${base.appId}: its foreground state could not be read (${foreground.error}); call appLifecycle with action background first or retry once the device responds`,
      };
    }
    if (foreground.state === "foreground") {
      return {
        ...attempt,
        errorCode: "app_in_foreground",
        error: `Call appLifecycle with action background first: am kill does nothing to foreground app ${base.appId}`,
      };
    }
    signal?.throwIfAborted();
    options.onMutation?.();
    try {
      await this.adb.executeCommand(`shell am kill --user ${userId} ${shellQuote(base.appId)}`, {
        timeoutMs: COMMAND_TIMEOUT_MS,
        noRetry: true,
        signal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[AppLifecycle] Android kill command failed for ${base.appId}`, error);
      return { ...attempt, errorCode: "kill_failed", error: errorMessage(error) };
    } finally {
      this.cacheInvalidator.invalidate(this.device);
    }
    // Neither command output nor its exit status proves reclamation. Only a
    // successful later process-table read can establish disappearance of pidBefore.
    return this.confirmReclaim(target, signal);
  }

  private async confirmReclaim(
    target: AndroidLifecycleTarget,
    signal?: AbortSignal,
  ): Promise<AppLifecycleResult> {
    const { base, userId, pidBefore } = target;
    const deadline = this.timer.now() + RECLAIM_POLL_BUDGET_MS;
    const backoff = fixedBackoff(RECLAIM_POLL_INTERVAL_MS);
    let pidAfter: number | null = pidBefore;
    let verifiedRead = false;
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const { processes } = await readAndroidPackageProcesses(this.adb, base.appId, {
          signal,
          timer: this.timer,
        });
        signal?.throwIfAborted();
        pidAfter = findAndroidPackageProcessId(processes, base.appId, userId);
        verifiedRead = true;
        if (!processes.some((process) => process.userId === userId && process.pid === pidBefore)) {
          return { ...base, success: true, pidBefore, pidAfter, processReclaimed: true };
        }
      } catch (error) {
        signal?.throwIfAborted();
        logger.warn(`[AppLifecycle] Process reclaim verification failed for ${base.appId}`, error);
      }
      const remaining = deadline - this.timer.now();
      if (remaining <= 0) {
        break;
      }
      await awaitWhileRequestIsLive(
        this.timer.sleep(Math.min(backoff.delayForAttempt(attempt), remaining)),
        signal,
      );
    }
    return {
      ...base,
      success: true,
      pidBefore,
      pidAfter,
      processReclaimed: false,
      message: verifiedRead
        ? "Process was not reclaimed; Android only kills processes it considers safe to kill"
        : "Process reclaim could not be verified because process-table reads failed",
    };
  }
}
