import { getIosLockStateCache } from "../observe/ios/IosLockStateCacheRegistry";
import type { IosLockStateInvalidator } from "../observe/ios/CachedIosLockStateProbe";
import { throwIfAborted, awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { ActionableError, BootedDevice, type DeviceLockState } from "../../models";
import { logger } from "../../utils/logger";
import { defaultTimer, Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { errorMessage } from "../../utils/describeUnknownError";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import {
  NotifyutilIosLockStateProbe,
  lockStateOf,
  type IosLockStateProbe,
} from "../observe/ios/IosLockStateProbe";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import {
  IOS_FOREGROUND_RESTORE_MAX_MS,
  iosPreLockForeground,
  SimctlIosForegroundRestorer,
  type IosForegroundRestorer,
  type IosPreLockForegroundRegistry,
} from "./IosForegroundRestore";

import type { LockCredentialStore, WakeAndUnlockResult } from "../../models/WakeAndUnlock";
export type {
  DeviceLockType,
  LockCredentialStore,
  WakeAndUnlockResult,
} from "../../models/WakeAndUnlock";
import { AndroidWakeAndUnlock } from "../../utils/android-cmdline-tools/AndroidWakeAndUnlock";
import type { ActionCall } from "./ActionCall";
/**
 * iOS wake + swipe-dismiss seam. iOS simulators cannot set a device passcode, so
 * there is no secure bouncer to enter a PIN into — "unlock" is waking the screen
 * and swiping the non-secure lock screen away. Implemented over the existing
 * gesture primitives; a fake in tests.
 */
export interface IosUnlockOptions {
  remainingMs: () => number;
  signal?: AbortSignal;
  readUnlocked?: (options?: {
    signal?: AbortSignal;
    phase?: "afterWake" | "afterSwipe";
  }) => Promise<boolean | undefined>;
}

export interface IosScreenUnlocker {
  wakeAndDismiss(
    options?: IosUnlockOptions | (() => number),
    signal?: AbortSignal,
  ): Promise<{
    success: boolean;
    error?: string;
    warning?: string;
    /** The swipe was applied and the lock state read locked afterwards: no gesture is pending. */
    stillLocked?: true;
    /** With stillLocked: whether a second wake (Home press) was made after the swipe. */
    rewoke?: boolean;
  }>;
}

/** The same runner recovery operations used by iOS observe. */
export interface IosRunnerRecovery {
  isConnected(): boolean;
  ensureRecoveryStarted(): void;
  ensureConnected(): Promise<boolean>;
  awaitRecovery(budgetMs: number): Promise<"recovered" | "not_recovering" | "failed" | "timed_out">;
}

export interface WakeAndUnlockOptions {
  timer?: Timer;
  /** Host wall clock used only to translate the daemon deadline into a timer budget. */
  wallClockNow?: () => number;
  credentialStore?: LockCredentialStore;
  iosUnlocker?: IosScreenUnlocker;
  iosRunnerRecovery?: IosRunnerRecovery;
  iosLockStateProbe?: IosLockStateProbe;
  iosLockStateInvalidator?: IosLockStateInvalidator;
  /** The app in front before `pressButton power` locked the simulator (#19231). */
  iosPreLockForeground?: IosPreLockForegroundRegistry;
  iosForegroundRestorer?: IosForegroundRestorer;
}

// The daemon's default MCP request timeout is 30s (src/daemon/mcpRequestTimeout.ts:25).
// Reserve 5s for result delivery; all iOS phases share this one deadline.
const IOS_UNLOCK_TOTAL_MS = 25_000;
// Match SetUIState RESPONSE_HEADROOM_MS for response serialization/delivery.
const IOS_UNLOCK_RESPONSE_HEADROOM_MS = 3_000;
const IOS_RECOVERY_WAIT_MS = 20_000;
// One final simulator probe can use a small part of the response headroom when
// recovery consumes the unlock deadline. Never extend gesture/recovery budgets.
const IOS_RECOVERY_LOCK_PROBE_GRACE_MS = 250;
/** Lock-state settle poll: notifyutil lockstate can lag a swipe that did unlock. */
export const IOS_UNLOCK_POLL_INTERVAL_MS = 250;
export const IOS_UNLOCK_POLL_MAX_MS = 2_500;

/**
 * Wake and (if needed) unlock a device — the cross-platform capability behind the
 * `wakeAndUnlock` MCP tool (issue #4360).
 *
 * Android: wake a sleeping device; dismiss a swipe keyguard; or unlock a secure
 * keyguard by raising the bouncer and typing the PIN as key events (the
 * accessibility path cannot type into a secure bouncer). The outcome is grounded
 * in a bounded re-read poll of the lock state, never in the fact that keys were
 * sent. See docs/how-it-works/plat/android/keyguard.md.
 *
 * iOS: wake and swipe-dismiss the non-secure lock screen; a `pin` is ignored
 * (simulators have no settable passcode).
 */
export class WakeAndUnlock {
  private readonly invalidateIosLockState: () => void;
  private readonly device: BootedDevice;
  private readonly androidUnlocker: AndroidWakeAndUnlock;
  private readonly timer: Timer;
  private readonly wallClockNow: () => number;
  private readonly iosUnlocker?: IosScreenUnlocker;
  private readonly iosRunnerRecovery?: IosRunnerRecovery;
  private readonly iosLockStateProbe?: IosLockStateProbe;
  private readonly iosPreLockForeground: IosPreLockForegroundRegistry;
  private readonly iosForegroundRestorer: () => IosForegroundRestorer;

  constructor(
    device: BootedDevice,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = defaultAdbClientFactory,
    options: WakeAndUnlockOptions = {},
  ) {
    this.device = device;
    this.invalidateIosLockState = () =>
      (options.iosLockStateInvalidator ?? getIosLockStateCache()).invalidate(device.deviceId);
    this.androidUnlocker = new AndroidWakeAndUnlock(device, adbFactoryOrExecutor, options);
    this.timer = options.timer ?? defaultTimer;
    this.wallClockNow = options.wallClockNow ?? (() => defaultTimer.now());
    this.iosUnlocker = options.iosUnlocker;
    this.iosRunnerRecovery = options.iosRunnerRecovery;
    this.iosLockStateProbe =
      device.platform === "ios"
        ? (options.iosLockStateProbe ?? new NotifyutilIosLockStateProbe())
        : undefined;
    this.iosPreLockForeground = options.iosPreLockForeground ?? iosPreLockForeground;
    this.iosForegroundRestorer = () =>
      options.iosForegroundRestorer ??
      new SimctlIosForegroundRestorer(device.deviceId, new SimCtlClient(device));
  }

  /**
   * @param pin - Credential for a secure Android device. Optional in the schema
   *   but logically required to unlock a secure lock: if omitted, a
   *   previously-remembered credential is used, else an ActionableError is
   *   thrown. Ignored on iOS.
   * @param transportDeadlineMs - Daemon absolute host-clock deadline; bounds simulator unlock.
   */
  async execute(pin?: string, call?: ActionCall): Promise<WakeAndUnlockResult>;
  /** @deprecated Pass an {@link ActionCall} instead of positional arguments. */
  async execute(
    pin?: string,
    transportDeadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<WakeAndUnlockResult>;
  async execute(
    pin?: string,
    deadlineOrCall?: number | ActionCall,
    signalArg?: AbortSignal,
  ): Promise<WakeAndUnlockResult> {
    const { deadlineMs: transportDeadlineMs, signal } =
      typeof deadlineOrCall === "object"
        ? deadlineOrCall
        : { deadlineMs: deadlineOrCall, signal: signalArg };
    throwIfAborted(signal);
    switch (this.device.platform) {
      case "android":
        return this.androidUnlocker.execute(pin, signal);
      case "ios":
        this.invalidateIosLockState();
        try {
          return await this.executeIos(transportDeadlineMs, signal);
        } finally {
          this.invalidateIosLockState();
        }
      default:
        throw new ActionableError(`wakeAndUnlock: unsupported platform ${this.device.platform}`);
    }
  }

  private iosUnlockDeadline(transportDeadlineMs?: number): number {
    const simulator = resolveIosDeviceKind({ deviceId: this.device.deviceId }) === "simulator";
    // Transport deadlines use the host wall clock. Convert once so injected
    // timers can use their own epoch throughout recovery, gestures, and polling.
    const budgetMs =
      simulator && transportDeadlineMs !== undefined && Number.isFinite(transportDeadlineMs)
        ? Math.max(
            0,
            Math.min(
              IOS_UNLOCK_TOTAL_MS,
              transportDeadlineMs - this.wallClockNow() - IOS_UNLOCK_RESPONSE_HEADROOM_MS,
            ),
          )
        : IOS_UNLOCK_TOTAL_MS;
    return this.timer.now() + budgetMs;
  }

  private async executeIos(
    transportDeadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<WakeAndUnlockResult> {
    throwIfAborted(signal);
    if (!this.iosUnlocker) {
      throw new ActionableError("wakeAndUnlock: iOS unlocker is not configured");
    }
    const simulator = resolveIosDeviceKind({ deviceId: this.device.deviceId }) === "simulator";
    const deadline = this.iosUnlockDeadline(transportDeadlineMs);
    // Read, not cleared: a failed unlock keeps the record so a retry that succeeds can restore.
    const appBeforeLock = simulator
      ? this.iosPreLockForeground.get(this.device.deviceId)
      : undefined;
    if (simulator) {
      const initialLock = await this.readIosLockState(deadline, signal);
      if (!initialLock) {
        throw new ActionableError("wakeAndUnlock: could not read the iOS lock state before unlock");
      }
      if (!initialLock.locked) {
        // Already unlocked: the lock the record belongs to is over and must not restore later.
        this.iosPreLockForeground.clear(this.device.deviceId);
        return this.iosResult(true, false);
      }
    }

    const recoveryResult = await this.prepareIosUnlock(deadline, simulator, signal);
    if (recoveryResult) {
      return this.restoreAppBeforeLock(recoveryResult, appBeforeLock, deadline, signal);
    }
    throwIfAborted(signal);
    let stageLock: DeviceLockState | undefined;
    const result = await awaitWhileRequestIsLive(
      this.iosUnlocker.wakeAndDismiss({
        remainingMs: () => deadline - this.timer.now(),
        signal,
        ...(simulator
          ? {
              readUnlocked: async (options) => {
                const probeSignal = options?.signal ?? signal;
                const lock = await this.readIosLockState(deadline, probeSignal);
                // A timed-out pre-swipe read must not overwrite a later stage's state.
                throwIfAborted(probeSignal);
                // An unprobed (undefined) read must never replace a real reading.
                if (lock && (options?.phase !== "afterWake" || !lock.locked)) {
                  stageLock = lock;
                }
                return lock ? !lock.locked : undefined;
              },
            }
          : {}),
      }),
      signal,
    );
    // A transport timeout leaves the Swift gesture's completion unknown. Never
    // issue a second swipe (or a post-swipe runner request) after that failure.
    if (!simulator) {
      return result.success
        ? this.iosResult(true, false)
        : this.iosResult(false, false, result.error);
    }
    const unlocked = await this.finishIosUnlock({ result, stageLock, deadline, signal });
    return this.restoreAppBeforeLock(unlocked, appBeforeLock, deadline, signal);
  }

  /**
   * Every simulator unlock path wakes through SpringBoard, which lands on the home screen and
   * backgrounds the app that was in front before the lock (#19231). Bring that app back after a
   * verified unlock; a failure is a warning, since the device is unlocked either way. The record
   * is cleared only here, after the unlock succeeded, so one lock restores at most once.
   */
  private async restoreAppBeforeLock(
    result: WakeAndUnlockResult,
    appId: string | undefined,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<WakeAndUnlockResult> {
    if (!result.success) {
      return result;
    }
    this.iosPreLockForeground.clear(this.device.deviceId);
    if (!appId) {
      return result;
    }
    const timeoutMs = Math.min(IOS_FOREGROUND_RESTORE_MAX_MS, deadline - this.timer.now());
    let warning: string | undefined;
    try {
      warning =
        timeoutMs <= 0
          ? `${appId} was left in the background: no time remained to bring it back to the front; call launchApp to return to it`
          : await raceWithDeadline(
              () => this.iosForegroundRestorer().restore(appId, { timeoutMs, signal }),
              {
                timer: this.timer,
                signal,
                timeoutMs,
                label: `bringing ${appId} back to the front`,
              },
            );
    } catch (error) {
      throwIfAborted(signal);
      warning = `${appId} was left in the background: bringing it back to the front failed (${errorMessage(error)}); call launchApp to return to it`;
      logger.warn(`[WakeAndUnlock] ${warning}`, error);
    }
    return warning
      ? { ...result, warning: [result.warning, warning].filter(Boolean).join("; ") }
      : result;
  }

  private async finishIosUnlock({
    result,
    stageLock,
    deadline,
    signal,
  }: {
    result: {
      success: boolean;
      error?: string;
      warning?: string;
      stillLocked?: true;
      rewoke?: boolean;
    };
    stageLock?: DeviceLockState;
    deadline: number;
    signal?: AbortSignal;
  }): Promise<WakeAndUnlockResult> {
    const swipeFailure = result.success
      ? undefined
      : (result.error ?? "iOS lock-screen swipe failed");
    const confirmed =
      stageLock?.locked === false
        ? {
            ...this.iosResult(true, true),
            ...(swipeFailure
              ? {
                  warning: `the lock-screen swipe did not complete (${swipeFailure}); the device is unlocked`,
                }
              : {}),
          }
        : await this.confirmIosSimulatorUnlocked({
            deadline,
            swipeFailure,
            stillLocked: result.stillLocked === true,
            rewoke: result.rewoke === true,
            signal,
            lastLock: result.warning ? undefined : stageLock,
          });
    logger.info(`[WakeAndUnlock] iOS unlock confirmed: ${result.warning ?? "fast swipe"}`);
    return result.warning && confirmed.success
      ? { ...confirmed, warning: [confirmed.warning, result.warning].filter(Boolean).join("; ") }
      : confirmed;
  }

  private async prepareIosUnlock(
    deadline: number,
    simulator: boolean,
    signal?: AbortSignal,
  ): Promise<WakeAndUnlockResult | undefined> {
    try {
      const recovery = this.iosRunnerRecovery;
      if (recovery && !recovery.isConnected()) {
        await awaitWhileRequestIsLive(
          this.waitForIosRunner(
            recovery,
            Math.min(deadline, this.timer.now() + IOS_RECOVERY_WAIT_MS),
            signal,
          ),
          signal,
        );
      }
      if (this.timer.now() >= deadline) {
        throw new ActionableError(
          "wakeAndUnlock: iOS unlock budget exhausted before swipe; retry after the runner reconnects",
        );
      }
      return undefined;
    } catch (error) {
      throwIfAborted(signal);
      if (!simulator) {
        throw error;
      }
      // Runner relaunch can unlock a simulator without our gesture. Only a
      // readable unlocked state makes it safe to return success with a warning.
      const probeDeadline =
        this.timer.now() < deadline
          ? deadline
          : this.timer.now() + IOS_RECOVERY_LOCK_PROBE_GRACE_MS;
      const lock = await this.readIosLockState(probeDeadline, signal);
      throwIfAborted(signal);
      if (!lock || lock.locked) {
        logger.warn(`[WakeAndUnlock] iOS runner recovery failed: ${errorMessage(error)}`, error);
        throw error;
      }
      const warning =
        `iOS runner had not finished recovering (${errorMessage(error)}); ` +
        "the device is unlocked, but the next observe may need a moment";
      logger.warn(`[WakeAndUnlock] ${warning}`);
      return { ...this.iosResult(true, true), warning };
    }
  }

  private async confirmIosSimulatorUnlocked({
    deadline,
    swipeFailure,
    stillLocked = false,
    rewoke = false,
    signal,
    lastLock,
  }: {
    deadline: number;
    swipeFailure: string | undefined;
    /** No gesture is in flight, so only the short settle window applies. */
    stillLocked?: boolean;
    /** With stillLocked: a second wake was made after the swipe. */
    rewoke?: boolean;
    signal?: AbortSignal;
    lastLock?: DeviceLockState;
  }): Promise<WakeAndUnlockResult> {
    throwIfAborted(signal);
    const finalLock =
      (await this.pollIosUnlocked(
        deadline,
        swipeFailure === undefined || stillLocked ? IOS_UNLOCK_POLL_MAX_MS : Infinity,
        signal,
      )) ?? lastLock;
    if (!finalLock) {
      throw new ActionableError(
        `wakeAndUnlock: could not read the iOS lock state after the swipe${swipeFailure ? ` (swipe failed: ${swipeFailure})` : ""}; re-observe the device`,
      );
    }
    if (finalLock.locked) {
      throw new ActionableError(
        stillLocked
          ? `wakeAndUnlock: iOS lock screen is still showing (${swipeFailure}); re-observe the device and call wakeAndUnlock again`
          : swipeFailure
            ? `wakeAndUnlock: iOS lock screen is still locked after the swipe failed (${swipeFailure}); re-observe the device`
            : "wakeAndUnlock: iOS swipe reported success but the device is still locked; re-observe the device",
      );
    }
    if (swipeFailure) {
      logger.warn(
        `[WakeAndUnlock] iOS lock-screen swipe failed (${swipeFailure}) but the lock state is unlocked; trusting the lock state`,
      );
      return {
        ...this.iosResult(true, true),
        warning: lateUnlockWarning(swipeFailure, stillLocked, rewoke),
      };
    }
    return this.iosResult(true, true);
  }

  private async waitForIosRunner(
    recovery: IosRunnerRecovery,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    recovery.ensureRecoveryStarted();
    const recoveryBudget = Math.max(0, deadline - this.timer.now());
    let outcome = await raceWithDeadline(() => recovery.awaitRecovery(recoveryBudget), {
      timer: this.timer,
      signal,
      timeoutMs: recoveryBudget,
      label: "iOS runner recovery before unlock",
    });
    if (recovery.isConnected() && this.timer.now() < deadline) {
      return;
    }
    // ensureRecoveryStarted can find no in-flight recovery. In that case the
    // normal client connection path starts setup/reconnect; join its result,
    // then the same recovery promise used by observe, within one deadline.
    if (outcome === "not_recovering" && this.timer.now() < deadline) {
      const connected = await raceWithDeadline(() => recovery.ensureConnected(), {
        timer: this.timer,
        signal,
        timeoutMs: deadline - this.timer.now(),
        label: "iOS runner reconnection before unlock",
      });
      if (connected && recovery.isConnected()) {
        return;
      }
      const remaining = deadline - this.timer.now();
      if (remaining <= 0) {
        throw new ActionableError(
          "wakeAndUnlock: iOS runner recovery budget exhausted before swipe",
        );
      }
      outcome = await raceWithDeadline(() => recovery.awaitRecovery(remaining), {
        timer: this.timer,
        signal,
        timeoutMs: remaining,
        label: "iOS runner recovery before unlock",
      });
      if (recovery.isConnected() && this.timer.now() < deadline) {
        return;
      }
    }
    throw new ActionableError(
      `wakeAndUnlock: iOS runner recovery ${outcome} while lock state is locked; retry after the runner reconnects`,
    );
  }

  private iosResult(success: boolean, wasLocked: boolean, error?: string): WakeAndUnlockResult {
    return {
      success,
      platform: "ios",
      // iOS wakefulness is unavailable; physical-device lock state remains unknown.
      wasAsleep: false,
      wasLocked,
      unlocked: success,
      error,
    };
  }

  private async readIosLockState(
    deadline: number,
    signal?: AbortSignal,
  ): Promise<DeviceLockState | undefined> {
    throwIfAborted(signal);
    const remaining = deadline - this.timer.now();
    const probe = this.iosLockStateProbe;
    if (remaining <= 0 || !probe) {
      return undefined;
    }
    try {
      return lockStateOf(
        await raceWithDeadline(() => probe.read(this.device.deviceId), {
          timer: this.timer,
          signal,
          timeoutMs: remaining,
          label: "iOS lock-state probe",
        }),
      );
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`[WakeAndUnlock] iOS lock-state probe exceeded unlock budget: ${error}`, error);
      return undefined;
    }
  }

  private async pollIosUnlocked(
    overallDeadline: number,
    maxWindowMs: number,
    signal?: AbortSignal,
  ): Promise<DeviceLockState | undefined> {
    throwIfAborted(signal);
    const deadline = Math.min(overallDeadline, this.timer.now() + maxWindowMs);
    let lastReadable: DeviceLockState | undefined;
    while (this.timer.now() < deadline) {
      const lock = await this.readIosLockState(deadline, signal);
      if (lock) {
        lastReadable = lock;
        if (!lock.locked) {
          return lock;
        }
      }
      const remaining = deadline - this.timer.now();
      if (remaining > 0) {
        throwIfAborted(signal);
        await awaitWhileRequestIsLive(
          this.timer.sleep(Math.min(IOS_UNLOCK_POLL_INTERVAL_MS, remaining)),
          signal,
        );
      }
    }
    return lastReadable;
  }
}

function lateUnlockWarning(swipeFailure: string, stillLocked: boolean, rewoke: boolean): string {
  if (!stillLocked) {
    return `the lock-screen swipe did not complete (${swipeFailure}); the device is unlocked`;
  }
  return rewoke
    ? "the lock screen dismissed late, after a second wake; the device is unlocked"
    : "the lock screen dismissed late, after the swipe; the device is unlocked";
}
