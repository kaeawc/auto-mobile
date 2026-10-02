import type { AppLifecycleAction, AppLifecycleResult, BootedDevice } from "../../models";
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
}
interface AndroidLifecycleTarget {
  base: AppLifecycleResult;
  userId: number;
  pidBefore: number;
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
        await new HomeScreen(device, null, this.timer).execute(undefined, signal);
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
    const base: AppLifecycleResult = {
      success: false,
      supported: this.device.platform === "android",
      action,
      platform: this.device.platform,
      appId,
      mechanism: action === "background" ? "home" : "am-kill",
    };
    if (this.device.platform === "ios") {
      // D23 makes BOTH actions unsupported: no verified iOS PID/state-preserving termination contract.
      return {
        ...base,
        mechanism: "unsupported",
        error:
          "No verified state-preserving termination mechanism on iOS; use homeScreen for Home or terminateApp for force-stop",
      };
    }
    if (!ANDROID_PACKAGE_NAME_PATTERN.test(appId)) {
      return {
        ...base,
        errorCode: "invalid_app_id",
        error: `${appId} is not a valid Android package name`,
      };
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
    return action === "background"
      ? this.background(target, options)
      : this.killBackgrounded(target, options);
  }

  private async isForeground(
    appId: string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const foreground = await this.adb.getForegroundApp(signal, COMMAND_TIMEOUT_MS);
    signal?.throwIfAborted();
    // getForegroundApp returns null on read failure as well as no foreground;
    // the existing API cannot distinguish them, so null means not foreground here.
    return foreground?.packageName === appId && foreground.userId === userId;
  }

  private async background(
    target: AndroidLifecycleTarget,
    options: AppLifecycleExecutionOptions,
  ): Promise<AppLifecycleResult> {
    const { base, userId, pidBefore } = target;
    const { signal } = options;
    if (await this.isForeground(base.appId, userId, signal)) {
      signal?.throwIfAborted();
      options.onMutation?.();
      try {
        await this.home.execute(signal);
      } finally {
        this.cacheInvalidator.invalidate(this.device);
      }
    }
    if (await this.isForeground(base.appId, userId, signal)) {
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
    if (await this.isForeground(base.appId, userId, signal)) {
      return {
        ...attempt,
        errorCode: "app_in_foreground",
        error: `Call appLifecycle with action background first: am kill does nothing to foreground app ${base.appId}`,
      };
    }
    signal?.throwIfAborted();
    options.onMutation?.();
    try {
      await this.adb.executeCommand(
        `shell am kill --user ${userId} ${shellQuote(base.appId)}`,
        COMMAND_TIMEOUT_MS,
        undefined,
        true,
        signal,
      );
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
