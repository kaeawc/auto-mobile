import os from "node:os";
import type { AppLifecycleAction, AppLifecycleResult, BootedDevice } from "../../models";
import { fixedBackoff } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import {
  SimulatorIosCrashBackend,
  type SimulatorCrashCommandRunner,
} from "../../utils/ios-cmdline-tools/IosCrashBackend";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { PhysicalIosAppCrasher } from "../../utils/ios-cmdline-tools/PhysicalIosAppCrasher";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive } from "../../utils/toolUtils";
import type { AppLifecycleExecutionOptions, AppLifecycleHome } from "./AppLifecycle";
import { findIosSimulatorAppProcess } from "./CrashApp";
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
}

/**
 * State-preserving background and kill for an iOS app (#14098). iOS keeps restoration state when
 * a backgrounded app is terminated by the system but discards it on an app-switcher force-quit.
 * Xcode reproduces system termination by backgrounding then sending SIGKILL, which is what
 * `killBackgrounded` does. There is no cheap iOS foreground read, so `killBackgrounded` presses
 * Home first (verified by HomeScreen, a no-op when already on Home) instead of refusing.
 */
export class IosAppLifecycle {
  private readonly control: IosAppProcessControl;
  private readonly timer: Timer;

  constructor(
    private readonly device: BootedDevice,
    private readonly dependencies: IosAppLifecycleDependencies,
  ) {
    this.timer = dependencies.timer ?? defaultTimer;
    this.control =
      dependencies.control ??
      (resolveIosDeviceKind({ deviceId: device.deviceId }) === "simulator"
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
      mechanism: action === "background" ? "home" : "ios-sigkill",
    };
    if (action === "trimMemory") {
      return {
        ...base,
        supported: false,
        mechanism: "unsupported",
        error: "iOS has no onTrimMemory equivalent to send",
      };
    }
    if (!BUNDLE_ID_PATTERN.test(appId)) {
      return {
        ...base,
        errorCode: "invalid_app_id",
        error: `${appId} is not a valid iOS bundle identifier`,
      };
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
    const backgrounded = await this.pressHome(base, found.pid, options);
    if (backgrounded || action === "background") {
      return backgrounded ?? { ...base, success: true, pid: found.pid };
    }
    return this.killBackgrounded(base, appId, options);
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
