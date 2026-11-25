import os from "node:os";
import {
  IOS_MEMORY_WARNING_LEVEL,
  type AppLifecycleAction,
  type AppLifecycleResult,
  type AppLifecycleTrimLevel,
  type BootedDevice,
} from "../../models";
import { fixedBackoff } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import {
  SimulatorIosCrashBackend,
  type SimulatorCrashCommandRunner,
} from "../../utils/ios-cmdline-tools/IosCrashBackend";
import {
  resolveIosDeviceKind,
  type IosDeviceKind,
} from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { PhysicalIosAppCrasher } from "../../utils/ios-cmdline-tools/PhysicalIosAppCrasher";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { observeForegroundApp } from "../accessibility/IosForegroundApp";
import type { AppLifecycleExecutionOptions, AppLifecycleHome } from "./AppLifecycle";
import { findIosSimulatorAppProcess } from "./CrashApp";
import {
  isMissingFileError,
  nodeMemoryWarningFileSystem,
  simulatorMemoryWarningPath,
  touchSimulatorMemoryWarning,
  type MemoryWarningFileSystem,
  type SimulatorMemoryWarningPathOptions,
} from "./IosSimulatorMemoryWarning";
import type { DeviceWindowCacheInvalidator } from "./TerminateApp";

const COMMAND_TIMEOUT_MS = 5_000;
const RECLAIM_POLL_BUDGET_MS = 5_000;
const RECLAIM_POLL_INTERVAL_MS = 250;
/**
 * Time after the verified Home press before the kill. iOS saves UIKit restoration state and
 * SwiftUI `@SceneStorage` as the scene enters the background; this lets that finish.
 */
const BACKGROUND_SETTLE_MS = 1_000;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/** One running iOS app process the kill can target. */
export interface IosAppProcess {
  pid: number;
  /** `UIKitApplication:<bundle>[…]` launchd label, Simulator only. */
  serviceLabel?: string;
}

/**
 * How appLifecycle finds and kills an app process on one iOS device (#14098).
 * `find`: the process, `null` when installed but not running, `undefined` when not installed.
 * `kill`: `"already_exited"` when the process was gone before the signal landed.
 */
export interface IosAppProcessControl {
  find(appId: string, signal?: AbortSignal): Promise<IosAppProcess | null | undefined>;
  kill(
    appId: string,
    process: IosAppProcess,
    signal?: AbortSignal,
  ): Promise<"signalled" | "already_exited">;
}

/** Simulator: `simctl spawn launchctl list` finds the app, `launchctl kill SIGKILL` kills it. */
export function simulatorAppProcessControl(
  deviceId: string,
  simctl: SimulatorCrashCommandRunner,
  uid: () => number,
): IosAppProcessControl {
  const backend = new SimulatorIosCrashBackend(deviceId, simctl);
  return {
    async find(appId, signal) {
      const list = await backend.listProcesses({ timeoutMs: COMMAND_TIMEOUT_MS, signal });
      return findIosSimulatorAppProcess(list.stdout, appId);
    },
    async kill(_appId, process, signal) {
      if (!process.serviceLabel) {
        throw new Error("Simulator app process has no launchd service label");
      }
      await backend.killProcess({
        serviceLabel: process.serviceLabel,
        uid: uid(),
        timeoutMs: COMMAND_TIMEOUT_MS,
        signalName: "SIGKILL",
        signal,
      });
      return "signalled";
    },
  };
}

/** Physical device: devicectl resolves the PID by exact bundle path and signals it. */
export function physicalAppProcessControl(
  crasher: Pick<PhysicalIosAppCrasher, "findAppPid" | "sendKill">,
): IosAppProcessControl {
  return {
    async find(appId) {
      const pid = await crasher.findAppPid(appId);
      return typeof pid === "number" ? { pid } : pid;
    },
    kill: (_appId, process, signal) => crasher.sendKill(process.pid, { signal }),
  };
}

export interface IosAppLifecycleDependencies {
  home: AppLifecycleHome;
  timer?: Timer;
  cacheInvalidator: DeviceWindowCacheInvalidator;
  control?: IosAppProcessControl;
  simctl?: SimulatorCrashCommandRunner;
  uid?: () => number;
  memoryWarning?: IosMemoryWarningDependencies;
}

/** Simulated memory warning seams (#18754); each defaults to the real host. */
export interface IosMemoryWarningDependencies {
  fileSystem?: MemoryWarningFileSystem;
  /** Where the CoreSimulator device set lives. */
  path?: SimulatorMemoryWarningPathOptions;
  /** The app on screen, undefined when the read cannot name one. */
  foregroundApp?: (signal?: AbortSignal) => Promise<string | undefined>;
}

const MECHANISMS = {
  background: "home",
  killBackgrounded: "ios-sigkill",
  trimMemory: "simulator-memory-warning-file",
} as const;

/**
 * State-preserving background and kill for an iOS app (#14098). iOS keeps restoration state when
 * a backgrounded app is terminated by the system but discards it on an app-switcher force-quit.
 * Xcode reproduces system termination by backgrounding then sending SIGKILL, which is what
 * `killBackgrounded` does. There is no cheap iOS foreground read, so `killBackgrounded` presses
 * Home first (verified by HomeScreen, a no-op when already on Home) instead of refusing.
 * `trimMemory` on a simulator updates the device's `memory_warning_simulation` file, which UIKit
 * delivers to running apps; a backgrounded app may be suspended and miss it, so the target must be
 * in front (#18754). Physical devices have no equivalent.
 */
export class IosAppLifecycle {
  private readonly control: IosAppProcessControl;
  private readonly timer: Timer;
  private readonly kind: IosDeviceKind;

  constructor(
    private readonly device: BootedDevice,
    private readonly dependencies: IosAppLifecycleDependencies,
  ) {
    this.timer = dependencies.timer ?? defaultTimer;
    this.kind = resolveIosDeviceKind({ deviceId: device.deviceId });
    this.control =
      dependencies.control ??
      (this.kind === "simulator"
        ? simulatorAppProcessControl(
            device.deviceId,
            dependencies.simctl ?? new SimCtlClient(device),
            dependencies.uid ?? (() => os.userInfo().uid),
          )
        : physicalAppProcessControl(
            new PhysicalIosAppCrasher(device.deviceId, new DeviceAppManager()),
          ));
  }

  async execute(
    appId: string,
    action: AppLifecycleAction,
    options: AppLifecycleExecutionOptions,
  ): Promise<AppLifecycleResult> {
    const { signal } = options;
    signal?.throwIfAborted();
    const base: AppLifecycleResult = {
      success: false,
      supported: true,
      action,
      platform: "ios",
      appId,
      mechanism: MECHANISMS[action],
    };
    const refused = this.preflightRefusal(base, options.trimLevel);
    if (refused) {
      return refused;
    }
    const found = await this.control.find(appId, signal);
    signal?.throwIfAborted();
    if (!found) {
      return {
        ...base,
        errorCode: "app_not_running",
        error:
          found === undefined
            ? `${appId} is not installed on ${this.device.deviceId}`
            : `${appId} is not running`,
      };
    }
    if (action === "trimMemory") {
      return this.memoryWarning(base, found.pid, options);
    }
    const backgrounded = await this.pressHome(base, found.pid, options);
    if (backgrounded || action === "background") {
      return backgrounded ?? { ...base, success: true, pid: found.pid };
    }
    return this.killBackgrounded(base, appId, options);
  }

  /** Refusals that need no device command: device kind, bundle id and trim level. */
  private preflightRefusal(
    base: AppLifecycleResult,
    level: AppLifecycleTrimLevel | undefined,
  ): AppLifecycleResult | null {
    if (base.action === "trimMemory" && this.kind === "physical") {
      return {
        ...base,
        supported: false,
        mechanism: "unsupported",
        error:
          "Physical iOS devices have no memory warning to send; level memoryWarning works on simulators only",
      };
    }
    if (!BUNDLE_ID_PATTERN.test(base.appId)) {
      return {
        ...base,
        errorCode: "invalid_app_id",
        error: `${base.appId} is not a valid iOS bundle identifier`,
      };
    }
    return trimLevelRefusal(base, base.action, level);
  }

  /**
   * Only the app in front is sure to receive the warning (a backgrounded app may be suspended), so
   * a different foreground app is refused. An unreadable foreground still sends it, with a message
   * that delivery was not verified.
   */
  private async memoryWarning(
    base: AppLifecycleResult,
    pid: number,
    options: AppLifecycleExecutionOptions,
  ): Promise<AppLifecycleResult> {
    const { signal } = options;
    const { appId } = base;
    const attempt: AppLifecycleResult = {
      ...base,
      pidBefore: pid,
      trimLevel: IOS_MEMORY_WARNING_LEVEL,
    };
    const foreground = await this.readForeground(appId, signal);
    signal?.throwIfAborted();
    if (foreground !== undefined && foreground !== appId) {
      return {
        ...attempt,
        errorCode: "app_not_foreground",
        error:
          `${appId} is not the foreground app (${foreground} is). A simulated memory warning ` +
          "is only sure to reach the app in front; a backgrounded app may be suspended and miss " +
          "it. Bring it to the front with launchApp, then retry.",
      };
    }
    const path = simulatorMemoryWarningPath(
      this.device.deviceId,
      this.dependencies.memoryWarning?.path,
    );
    options.onMutation?.();
    try {
      await touchSimulatorMemoryWarning(
        path,
        this.dependencies.memoryWarning?.fileSystem ?? nodeMemoryWarningFileSystem,
        new Date(this.timer.now()),
      );
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[IosAppLifecycle] Memory warning file update failed for ${appId}`, error);
      return {
        ...attempt,
        errorCode: "trim_failed",
        error: isMissingFileError(error)
          ? `${path} does not exist; boot simulator ${this.device.deviceId} and retry`
          : `Could not update ${path}: ${errorMessage(error)}`,
      };
    }
    return {
      ...attempt,
      success: true,
      pid,
      message:
        foreground === undefined
          ? `Simulated a memory warning on ${this.device.deviceId}, but the foreground app could not be read; ` +
            `${appId} (pid ${pid}) receives it only if it is in front. Read its logs to see how it reacted`
          : `Simulated a memory warning for ${appId} (pid ${pid}); read its logs to see how it reacted`,
    };
  }

  private async readForeground(appId: string, signal?: AbortSignal): Promise<string | undefined> {
    const read =
      this.dependencies.memoryWarning?.foregroundApp ??
      ((readSignal?: AbortSignal) => observeForegroundApp(this.device, readSignal));
    try {
      return await read(signal);
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `[IosAppLifecycle] Foreground read failed before a memory warning for ${appId}`,
        error,
      );
      return undefined;
    }
  }

  /** Verified Home press; returns a failure result, or `null` once the app is backgrounded. */
  private async pressHome(
    base: AppLifecycleResult,
    pidBefore: number,
    options: AppLifecycleExecutionOptions,
  ): Promise<AppLifecycleResult | null> {
    const { signal } = options;
    signal?.throwIfAborted();
    options.onMutation?.();
    try {
      await this.dependencies.home.execute(signal);
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[IosAppLifecycle] Home press failed for ${base.appId}`, error);
      return {
        ...base,
        pidBefore,
        errorCode: "background_not_verified",
        error: `${base.appId} could not be verified as backgrounded: ${errorMessage(error)}`,
      };
    } finally {
      this.dependencies.cacheInvalidator.invalidate(this.device);
    }
    return null;
  }

  private async killBackgrounded(
    base: AppLifecycleResult,
    appId: string,
    options: AppLifecycleExecutionOptions,
  ): Promise<AppLifecycleResult> {
    const { signal } = options;
    await awaitWhileRequestIsLive(this.timer.sleep(BACKGROUND_SETTLE_MS), signal);
    // The PID can change if the app was relaunched, so read it again for the signal.
    const target = await this.control.find(appId, signal);
    signal?.throwIfAborted();
    if (!target) {
      return {
        ...base,
        errorCode: "app_not_running",
        error: `${appId} exited while it was being backgrounded; nothing was killed`,
      };
    }
    const attempt = { ...base, pidBefore: target.pid };
    options.onMutation?.();
    let outcome: "signalled" | "already_exited";
    try {
      outcome = await this.control.kill(appId, target, signal);
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[IosAppLifecycle] SIGKILL failed for ${appId}`, error);
      return { ...attempt, errorCode: "kill_failed", error: errorMessage(error) };
    } finally {
      this.dependencies.cacheInvalidator.invalidate(this.device);
    }
    if (outcome === "already_exited") {
      return {
        ...attempt,
        errorCode: "app_not_running",
        error: `${appId} (pid ${target.pid}) exited before the kill signal was delivered`,
      };
    }
    return this.confirmReclaim(attempt, appId, target.pid, signal);
  }

  /** SIGKILL is not catchable, so a process still present after the budget means it failed. */
  private async confirmReclaim(
    attempt: AppLifecycleResult,
    appId: string,
    pidBefore: number,
    signal?: AbortSignal,
  ): Promise<AppLifecycleResult> {
    const deadline = this.timer.now() + RECLAIM_POLL_BUDGET_MS;
    const backoff = fixedBackoff(RECLAIM_POLL_INTERVAL_MS);
    let pidAfter: number | null = pidBefore;
    for (let tick = 1; ; tick++) {
      signal?.throwIfAborted();
      try {
        const current = await this.control.find(appId, signal);
        signal?.throwIfAborted();
        pidAfter = current ? current.pid : null;
        if (pidAfter !== pidBefore) {
          return { ...attempt, success: true, pidAfter, processReclaimed: true };
        }
      } catch (error) {
        signal?.throwIfAborted();
        logger.warn(`[IosAppLifecycle] Process reclaim check failed for ${appId}`, error);
      }
      const remaining = deadline - this.timer.now();
      if (remaining <= 0) {
        break;
      }
      await awaitWhileRequestIsLive(
        this.timer.sleep(Math.min(backoff.delayForAttempt(tick), remaining)),
        signal,
      );
    }
    return {
      ...attempt,
      pidAfter,
      processReclaimed: false,
      errorCode: "kill_failed",
      error: `${appId} (pid ${pidBefore}) was still running ${RECLAIM_POLL_BUDGET_MS}ms after SIGKILL`,
    };
  }
}

/** trimMemory needs memoryWarning on a simulator and no other action takes a level. */
function trimLevelRefusal(
  base: AppLifecycleResult,
  action: AppLifecycleAction,
  level: AppLifecycleTrimLevel | undefined,
): AppLifecycleResult | null {
  if (action !== "trimMemory") {
    return level === undefined
      ? null
      : {
          ...base,
          errorCode: "trim_level_not_applicable",
          error: `level only applies to the trimMemory action, not ${action}`,
        };
  }
  if (level === IOS_MEMORY_WARNING_LEVEL) {
    return null;
  }
  return level === undefined
    ? {
        ...base,
        errorCode: "trim_level_required",
        error: "trimMemory on an iOS simulator needs level memoryWarning",
      }
    : {
        ...base,
        errorCode: "trim_level_not_applicable",
        error: `${level} is an Android onTrimMemory level; iOS simulators take level memoryWarning`,
      };
}
