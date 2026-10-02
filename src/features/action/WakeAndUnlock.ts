import { throwIfAborted, awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { ActionableError, BootedDevice, type DeviceLockState } from "../../models";
import { logger } from "../../utils/logger";
import { defaultTimer, Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { errorMessage } from "../../utils/describeUnknownError";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import {
  NotifyutilIosLockStateProbe,
  type IosLockStateProbe,
} from "../observe/ios/IosLockStateProbe";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { ANDROID_KEYCOMBINATION_MIN_API_LEVEL, buildAsciiKeyEventPlan } from "./asciiKeyEvents";

/** How a device's keyguard is protected, as far as AutoMobile can tell/remember. */
export type DeviceLockType = "none" | "swipe" | "pin" | "password" | "pattern";

/**
 * Persistence seam for remembering how to unlock a device across a session.
 *
 * Backed by the `device_sessions` table in production; a fake in tests. Kept a
 * narrow interface (YAGNI) so WakeAndUnlock does not depend on the repository.
 */
export interface LockCredentialStore {
  /** The credential remembered for a device, or `null` if none is recorded. */
  getRecordedCredential(deviceId: string): Promise<string | null>;
  /** Remember how to unlock a device (lock type + optional credential). */
  rememberLock(
    deviceId: string,
    lockType: DeviceLockType,
    credential: string | null,
  ): Promise<void>;
}

/**
 * iOS wake + swipe-dismiss seam. iOS simulators cannot set a device passcode, so
 * there is no secure bouncer to enter a PIN into — "unlock" is waking the screen
 * and swiping the non-secure lock screen away. Implemented over the existing
 * gesture primitives; a fake in tests.
 */
export interface IosUnlockOptions {
  remainingMs: () => number;
  signal?: AbortSignal;
  readUnlocked?: () => Promise<boolean | undefined>;
}

export interface IosScreenUnlocker {
  wakeAndDismiss(
    options?: IosUnlockOptions | (() => number),
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string; warning?: string }>;
}

/** The same runner recovery operations used by iOS observe. */
export interface IosRunnerRecovery {
  isConnected(): boolean;
  ensureRecoveryStarted(): void;
  ensureConnected(): Promise<boolean>;
  awaitRecovery(budgetMs: number): Promise<"recovered" | "not_recovering" | "failed" | "timed_out">;
}

export interface WakeAndUnlockResult {
  success: boolean;
  platform: "android" | "ios";
  /** Whether the device was asleep before this call (Android; unknown on iOS). */
  wasAsleep: boolean;
  /** Whether the keyguard was obscuring the app before this call. */
  wasLocked: boolean;
  /** Whether the lock was credential-protected (Android; undefined if unknown). */
  secure?: boolean;
  /** Whether the device is unlocked after this call. */
  unlocked: boolean;
  /** True when a secure device was unlocked using a previously-remembered PIN. */
  usedRecordedCredential?: boolean;
  error?: string;
  /** Device unlocked, but the iOS runner may still need time before the next observe. */
  warning?: string;
}

export interface WakeAndUnlockOptions {
  timer?: Timer;
  /** Host wall clock used only to translate the daemon deadline into a timer budget. */
  wallClockNow?: () => number;
  credentialStore?: LockCredentialStore;
  iosUnlocker?: IosScreenUnlocker;
  iosRunnerRecovery?: IosRunnerRecovery;
  iosLockStateProbe?: IosLockStateProbe;
}

// Timings. WAKE/BOUNCER settle let the display and bouncer animate before the
// next step; the unlock poll covers the ~1.3s lag measured between ENTER and the
// keyguard actually clearing in `dumpsys window policy` (issue #4360). The whole
// sequence stays inside the ~7s `config_lockScreenDisplayTimeout` budget.
const WAKE_SETTLE_MS = 500;
const BOUNCER_SETTLE_MS = 900;
const UNLOCK_POLL_INTERVAL_MS = 250;
const UNLOCK_POLL_MAX_MS = 2500;
// The daemon's default MCP request timeout is 30s (src/daemon/mcpRequestTimeout.ts:25).
// Reserve 5s for result delivery; all iOS phases share this one deadline.
const IOS_UNLOCK_TOTAL_MS = 25_000;
// Match SetUIState RESPONSE_HEADROOM_MS for response serialization/delivery.
const IOS_UNLOCK_RESPONSE_HEADROOM_MS = 3_000;
const IOS_RECOVERY_WAIT_MS = 20_000;
// One final simulator probe can use a small part of the response headroom when
// recovery consumes the unlock deadline. Never extend gesture/recovery budgets.
const IOS_RECOVERY_LOCK_PROBE_GRACE_MS = 250;
const IOS_UNLOCK_POLL_INTERVAL_MS = 250;
const IOS_UNLOCK_POLL_MAX_MS = 2_500;

/**
 * Wake and (if needed) unlock a device — the cross-platform capability behind the
 * `wakeAndUnlock` MCP tool (issue #4360).
 *
 * Android: wake a sleeping device; dismiss a swipe keyguard; or unlock a secure
 * keyguard by raising the bouncer and typing the PIN as key events (the
 * accessibility path cannot type into a secure bouncer). The outcome is grounded
 * in a bounded re-read poll of the lock state, never in the fact that keys were
 * sent. See docs/design-docs/plat/android/keyguard.md.
 *
 * iOS: wake and swipe-dismiss the non-secure lock screen; a `pin` is ignored
 * (simulators have no settable passcode).
 */
export class WakeAndUnlock {
  private readonly device: BootedDevice;
  private readonly adb: AdbExecutor;
  private readonly timer: Timer;
  private readonly wallClockNow: () => number;
  private readonly credentialStore?: LockCredentialStore;
  private readonly iosUnlocker?: IosScreenUnlocker;
  private readonly iosRunnerRecovery?: IosRunnerRecovery;
  private readonly iosLockStateProbe?: IosLockStateProbe;
  private keyCombinationSupported: boolean | undefined;

  constructor(
    device: BootedDevice,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = defaultAdbClientFactory,
    options: WakeAndUnlockOptions = {},
  ) {
    this.device = device;
    if (
      adbFactoryOrExecutor &&
      typeof (adbFactoryOrExecutor as AdbClientFactory).create === "function"
    ) {
      this.adb = (adbFactoryOrExecutor as AdbClientFactory).create(device);
    } else if (adbFactoryOrExecutor) {
      this.adb = adbFactoryOrExecutor as AdbExecutor;
    } else {
      this.adb = defaultAdbClientFactory.create(device);
    }
    this.timer = options.timer ?? defaultTimer;
    this.wallClockNow = options.wallClockNow ?? (() => defaultTimer.now());
    this.credentialStore = options.credentialStore;
    this.iosUnlocker = options.iosUnlocker;
    this.iosRunnerRecovery = options.iosRunnerRecovery;
    this.iosLockStateProbe =
      device.platform === "ios"
        ? (options.iosLockStateProbe ?? new NotifyutilIosLockStateProbe())
        : undefined;
  }

  /**
   * @param pin - Credential for a secure Android device. Optional in the schema
   *   but logically required to unlock a secure lock: if omitted, a
   *   previously-remembered credential is used, else an ActionableError is
   *   thrown. Ignored on iOS.
   * @param transportDeadlineMs - Daemon absolute host-clock deadline; bounds simulator unlock.
   */
  async execute(
    pin?: string,
    transportDeadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<WakeAndUnlockResult> {
    throwIfAborted(signal);
    switch (this.device.platform) {
      case "android":
        return this.executeAndroid(pin, signal);
      case "ios":
        return this.executeIos(transportDeadlineMs, signal);
      default:
        throw new ActionableError(`wakeAndUnlock: unsupported platform ${this.device.platform}`);
    }
  }

  private async executeAndroid(pin?: string, signal?: AbortSignal): Promise<WakeAndUnlockResult> {
    throwIfAborted(signal);
    const wakefulness = await awaitWhileRequestIsLive(this.adb.getWakefulness(), signal);
    const wasAsleep = wakefulness !== "Awake";
    if (wasAsleep) {
      logger.info("[WakeAndUnlock] device asleep, sending KEYCODE_WAKEUP");
      throwIfAborted(signal);
      await awaitWhileRequestIsLive(
        this.adb.executeCommand("shell input keyevent KEYCODE_WAKEUP"),
        signal,
      );
      throwIfAborted(signal);
      await awaitWhileRequestIsLive(this.timer.sleep(WAKE_SETTLE_MS), signal);
    }

    throwIfAborted(signal);
    const lock = await awaitWhileRequestIsLive(this.adb.getDeviceLock(signal), signal);
    if (lock === null) {
      // Unreadable lock state (dumpsys unavailable/unparsable). Never claim
      // "unlocked" from an absent signal — the device was woken, but its lock
      // status is unknown, so report that rather than a false success.
      logger.warn("[WakeAndUnlock] device woken but lock state could not be read");
      return {
        success: false,
        platform: "android",
        wasAsleep,
        wasLocked: false,
        unlocked: false,
        error:
          "Could not read device lock state (dumpsys window policy unavailable); the device was woken but its lock status is unknown",
      };
    }
    if (!lock.locked) {
      return {
        success: true,
        platform: "android",
        wasAsleep,
        wasLocked: false,
        secure: lock.secure,
        unlocked: true,
      };
    }

    // wm dismiss-keyguard fully dismisses a swipe lock and raises the bouncer on
    // a secure lock (verified #4360). Do it first, then branch on the credential
    // requirement.
    throwIfAborted(signal);
    await awaitWhileRequestIsLive(this.adb.executeCommand("shell wm dismiss-keyguard"), signal);

    // Only a *definitely* non-secure lock takes the pure swipe path. A secure
    // lock — or one whose `secure` field could not be read (`undefined`) — goes
    // through the credential path, which handles the unknown case rather than
    // guessing it is a swipe lock.
    return lock.secure === false
      ? this.dismissSwipe(wasAsleep, signal)
      : this.unlockSecure(wasAsleep, pin, lock.secure, signal);
  }

  private async dismissSwipe(
    wasAsleep: boolean,
    signal?: AbortSignal,
  ): Promise<WakeAndUnlockResult> {
    throwIfAborted(signal);
    const cleared = await this.pollUnlocked(signal);
    if (cleared) {
      await this.rememberLock("swipe", null, signal);
    }
    return {
      success: cleared,
      platform: "android",
      wasAsleep,
      wasLocked: true,
      secure: false,
      unlocked: cleared,
      error: cleared ? undefined : "Swipe keyguard did not dismiss",
    };
  }

  /**
   * @param secure - The pre-dismiss `secure` reading: `true` (definitely secure)
   *   or `undefined` (unknown). Never `false` here — that takes the swipe path.
   */
  private async unlockSecure(
    wasAsleep: boolean,
    pin: string | undefined,
    secure: boolean | undefined,
    signal?: AbortSignal,
  ): Promise<WakeAndUnlockResult> {
    throwIfAborted(signal);
    const recorded = pin ? null : await this.getRecordedCredential(signal);
    const effectivePin = pin ?? recorded;
    const usedRecordedCredential = !pin && !!recorded;

    if (!effectivePin) {
      if (secure === true) {
        throw new ActionableError(
          "Device is secure-locked (PIN/pattern/password); provide `pin` to unlock it. " +
            "Unlocking once with a `pin` lets AutoMobile remember it for later in this session.",
        );
      }
      // Unknown secure status and no credential: dismiss-keyguard (already
      // issued) may have cleared a swipe lock, so check before demanding a PIN.
      const cleared = await this.pollUnlocked(signal);
      if (cleared) {
        await this.rememberLock("swipe", null, signal);
        return {
          success: true,
          platform: "android",
          wasAsleep,
          wasLocked: true,
          secure: undefined,
          unlocked: true,
        };
      }
      throw new ActionableError(
        "Device is locked and its secure status could not be read; provide `pin` to unlock it if it is secure.",
      );
    }

    const commands = await this.buildCredentialCommands(effectivePin, signal);

    // The bouncer was raised by dismiss-keyguard; let it settle, type the
    // credential, and submit.
    throwIfAborted(signal);
    await awaitWhileRequestIsLive(this.timer.sleep(BOUNCER_SETTLE_MS), signal);
    for (const command of commands) {
      throwIfAborted(signal);
      await awaitWhileRequestIsLive(this.adb.executeCommand(command), signal);
    }
    throwIfAborted(signal);
    await awaitWhileRequestIsLive(
      this.adb.executeCommand("shell input keyevent KEYCODE_ENTER"),
      signal,
    );

    const cleared = await this.pollUnlocked(signal);
    if (!cleared) {
      logger.warn("[WakeAndUnlock] device remained locked after credential entry");
      // A *recorded* credential that failed is stale (the device PIN likely
      // changed). Forget it, so the next call does not re-submit it and drive
      // the keyguard retry throttle toward a lockout — it falls back to asking
      // for a PIN instead.
      if (usedRecordedCredential) {
        await this.rememberLock("pin", null, signal);
      }
      return {
        success: false,
        platform: "android",
        wasAsleep,
        wasLocked: true,
        secure,
        unlocked: false,
        usedRecordedCredential,
        error: "Device remained locked after PIN entry (wrong credential or entry failed)",
      };
    }

    // Only remember a credential the caller freshly supplied and that worked —
    // never re-persist a recorded one, and never a value that failed to unlock.
    if (pin) {
      await this.rememberLock("pin", pin, signal);
    }
    // A credential unlocked it, so it was in fact secure.
    return {
      success: true,
      platform: "android",
      wasAsleep,
      wasLocked: true,
      secure: true,
      unlocked: true,
      usedRecordedCredential,
    };
  }

  /** Expand a credential into its key-event commands, or throw if unmappable. */
  private async buildCredentialCommands(
    credential: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    throwIfAborted(signal);
    const supportsCombination = await this.supportsKeyCombination(signal);
    const chars = Array.from(credential);
    const commands: string[] = [];
    for (let index = 0; index < chars.length; index++) {
      const plan = buildAsciiKeyEventPlan(chars[index] ?? "", supportsCombination);
      if (!plan) {
        // Describe the offending character by position, never by value — the
        // credential must not leak into a tool-result error message.
        throw new ActionableError(
          `wakeAndUnlock: the credential character at position ${index + 1} cannot be sent as a key event on this device`,
        );
      }
      commands.push(...plan.commands);
    }
    return commands;
  }

  private iosUnlockDeadline(transportDeadlineMs?: number): number {
    const simulator = isIosSimulatorUdid(this.device.deviceId);
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
    const simulator = isIosSimulatorUdid(this.device.deviceId);
    const deadline = this.iosUnlockDeadline(transportDeadlineMs);
    if (simulator) {
      const initialLock = await this.readIosLockState(deadline, signal);
      if (!initialLock) {
        throw new ActionableError("wakeAndUnlock: could not read the iOS lock state before unlock");
      }
      if (!initialLock.locked) {
        return this.iosResult(true, false);
      }
    }

    const recoveryResult = await this.prepareIosUnlock(deadline, simulator, signal);
    if (recoveryResult) {
      return recoveryResult;
    }
    throwIfAborted(signal);
    let stageLock: DeviceLockState | undefined;
    const result = await awaitWhileRequestIsLive(
      this.iosUnlocker.wakeAndDismiss({
        remainingMs: () => deadline - this.timer.now(),
        signal,
        ...(simulator
          ? {
              readUnlocked: async () => {
                const lock = await this.readIosLockState(deadline, signal);
                stageLock = lock;
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
    return this.finishIosUnlock({ result, stageLock, deadline, signal });
  }

  private async finishIosUnlock({
    result,
    stageLock,
    deadline,
    signal,
  }: {
    result: { success: boolean; error?: string; warning?: string };
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
    signal,
    lastLock,
  }: {
    deadline: number;
    swipeFailure: string | undefined;
    signal?: AbortSignal;
    lastLock?: DeviceLockState;
  }): Promise<WakeAndUnlockResult> {
    throwIfAborted(signal);
    const finalLock =
      (await this.pollIosUnlocked(
        deadline,
        swipeFailure === undefined ? IOS_UNLOCK_POLL_MAX_MS : Infinity,
        signal,
      )) ?? lastLock;
    if (!finalLock) {
      throw new ActionableError(
        `wakeAndUnlock: could not read the iOS lock state after the swipe${swipeFailure ? ` (swipe failed: ${swipeFailure})` : ""}; re-observe the device`,
      );
    }
    if (finalLock.locked) {
      throw new ActionableError(
        swipeFailure
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
        warning: `the lock-screen swipe did not complete (${swipeFailure}); the device is unlocked`,
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
      return await raceWithDeadline(() => probe.read(this.device.deviceId), {
        timer: this.timer,
        signal,
        timeoutMs: remaining,
        label: "iOS lock-state probe",
      });
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

  /** Poll the lock state until the keyguard clears or the budget expires. */
  private async pollUnlocked(signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    let elapsed = 0;
    while (elapsed < UNLOCK_POLL_MAX_MS) {
      throwIfAborted(signal);
      const lock = await awaitWhileRequestIsLive(this.adb.getDeviceLock(signal), signal);
      if (lock && !lock.locked) {
        return true;
      }
      throwIfAborted(signal);
      await awaitWhileRequestIsLive(this.timer.sleep(UNLOCK_POLL_INTERVAL_MS), signal);
      elapsed += UNLOCK_POLL_INTERVAL_MS;
    }
    throwIfAborted(signal);
    const finalLock = await awaitWhileRequestIsLive(this.adb.getDeviceLock(signal), signal);
    return !!finalLock && !finalLock.locked;
  }

  /** Best-effort recorded-credential lookup: a store failure degrades to "none". */
  private async getRecordedCredential(signal?: AbortSignal): Promise<string | null> {
    throwIfAborted(signal);
    if (!this.credentialStore) {
      return null;
    }
    try {
      throwIfAborted(signal);
      return await awaitWhileRequestIsLive(
        this.credentialStore.getRecordedCredential(this.device.deviceId),
        signal,
      );
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(
        `[WakeAndUnlock] failed to read recorded credential for ${this.device.deviceId}: ${error}`,
      );
      return null;
    }
  }

  private async rememberLock(
    lockType: DeviceLockType,
    credential: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (!this.credentialStore) {
      return;
    }
    try {
      throwIfAborted(signal);
      await awaitWhileRequestIsLive(
        this.credentialStore.rememberLock(this.device.deviceId, lockType, credential),
        signal,
      );
    } catch (error) {
      throwIfAborted(signal);
      // Best-effort persistence: failing to remember must not fail the unlock the
      // caller actually asked for.
      logger.warn(`[WakeAndUnlock] failed to remember lock for ${this.device.deviceId}: ${error}`);
    }
  }

  private async supportsKeyCombination(signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    if (this.keyCombinationSupported !== undefined) {
      return this.keyCombinationSupported;
    }
    throwIfAborted(signal);
    const apiLevel = await readAndroidDeviceApiLevel(this.adb, undefined, this.timer, signal);
    this.keyCombinationSupported =
      apiLevel !== null && apiLevel >= ANDROID_KEYCOMBINATION_MIN_API_LEVEL;
    return this.keyCombinationSupported;
  }
}
