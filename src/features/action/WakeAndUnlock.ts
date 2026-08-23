import { ActionableError, BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { defaultTimer, Timer } from "../../utils/SystemTimer";
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
export interface IosScreenUnlocker {
  wakeAndDismiss(): Promise<{ success: boolean; error?: string }>;
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
}

export interface WakeAndUnlockOptions {
  timer?: Timer;
  credentialStore?: LockCredentialStore;
  iosUnlocker?: IosScreenUnlocker;
}

// Timings. WAKE/BOUNCER settle let the display and bouncer animate before the
// next step; the unlock poll covers the ~1.3s lag measured between ENTER and the
// keyguard actually clearing in `dumpsys window policy` (issue #4360). The whole
// sequence stays inside the ~7s `config_lockScreenDisplayTimeout` budget.
const WAKE_SETTLE_MS = 500;
const BOUNCER_SETTLE_MS = 900;
const UNLOCK_POLL_INTERVAL_MS = 250;
const UNLOCK_POLL_MAX_MS = 2500;

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
  private readonly credentialStore?: LockCredentialStore;
  private readonly iosUnlocker?: IosScreenUnlocker;
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
    this.credentialStore = options.credentialStore;
    this.iosUnlocker = options.iosUnlocker;
  }

  /**
   * @param pin - Credential for a secure Android device. Optional in the schema
   *   but logically required to unlock a secure lock: if omitted, a
   *   previously-remembered credential is used, else an ActionableError is
   *   thrown. Ignored on iOS.
   */
  async execute(pin?: string): Promise<WakeAndUnlockResult> {
    switch (this.device.platform) {
      case "android":
        return this.executeAndroid(pin);
      case "ios":
        return this.executeIos();
      default:
        throw new ActionableError(`wakeAndUnlock: unsupported platform ${this.device.platform}`);
    }
  }

  private async executeAndroid(pin?: string): Promise<WakeAndUnlockResult> {
    const wakefulness = await this.adb.getWakefulness();
    const wasAsleep = wakefulness !== "Awake";
    if (wasAsleep) {
      logger.info("[WakeAndUnlock] device asleep, sending KEYCODE_WAKEUP");
      await this.adb.executeCommand("shell input keyevent KEYCODE_WAKEUP");
      await this.timer.sleep(WAKE_SETTLE_MS);
    }

    const lock = await this.adb.getDeviceLock();
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
    await this.adb.executeCommand("shell wm dismiss-keyguard");

    // Only a *definitely* non-secure lock takes the pure swipe path. A secure
    // lock — or one whose `secure` field could not be read (`undefined`) — goes
    // through the credential path, which handles the unknown case rather than
    // guessing it is a swipe lock.
    return lock.secure === false
      ? this.dismissSwipe(wasAsleep)
      : this.unlockSecure(wasAsleep, pin, lock.secure);
  }

  private async dismissSwipe(wasAsleep: boolean): Promise<WakeAndUnlockResult> {
    const cleared = await this.pollUnlocked();
    if (cleared) {
      await this.rememberLock("swipe", null);
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
  ): Promise<WakeAndUnlockResult> {
    const recorded = pin ? null : await this.getRecordedCredential();
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
      const cleared = await this.pollUnlocked();
      if (cleared) {
        await this.rememberLock("swipe", null);
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

    const commands = await this.buildCredentialCommands(effectivePin);

    // The bouncer was raised by dismiss-keyguard; let it settle, type the
    // credential, and submit.
    await this.timer.sleep(BOUNCER_SETTLE_MS);
    for (const command of commands) {
      await this.adb.executeCommand(command);
    }
    await this.adb.executeCommand("shell input keyevent KEYCODE_ENTER");

    const cleared = await this.pollUnlocked();
    if (!cleared) {
      logger.warn("[WakeAndUnlock] device remained locked after credential entry");
      // A *recorded* credential that failed is stale (the device PIN likely
      // changed). Forget it, so the next call does not re-submit it and drive
      // the keyguard retry throttle toward a lockout — it falls back to asking
      // for a PIN instead.
      if (usedRecordedCredential) {
        await this.rememberLock("pin", null);
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
      await this.rememberLock("pin", pin);
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
  private async buildCredentialCommands(credential: string): Promise<string[]> {
    const supportsCombination = await this.supportsKeyCombination();
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

  private async executeIos(): Promise<WakeAndUnlockResult> {
    if (!this.iosUnlocker) {
      throw new ActionableError("wakeAndUnlock: iOS unlocker is not configured");
    }
    const result = await this.iosUnlocker.wakeAndDismiss();
    return {
      success: result.success,
      platform: "ios",
      // iOS exposes no lock/wakefulness read equivalent to Android's dumpsys, so
      // these are left conservative rather than guessed.
      wasAsleep: false,
      wasLocked: false,
      unlocked: result.success,
      error: result.error,
    };
  }

  /** Poll the lock state until the keyguard clears or the budget expires. */
  private async pollUnlocked(): Promise<boolean> {
    let elapsed = 0;
    while (elapsed < UNLOCK_POLL_MAX_MS) {
      const lock = await this.adb.getDeviceLock();
      if (lock && !lock.locked) {
        return true;
      }
      await this.timer.sleep(UNLOCK_POLL_INTERVAL_MS);
      elapsed += UNLOCK_POLL_INTERVAL_MS;
    }
    const finalLock = await this.adb.getDeviceLock();
    return !!finalLock && !finalLock.locked;
  }

  /** Best-effort recorded-credential lookup: a store failure degrades to "none". */
  private async getRecordedCredential(): Promise<string | null> {
    if (!this.credentialStore) {
      return null;
    }
    try {
      return await this.credentialStore.getRecordedCredential(this.device.deviceId);
    } catch (error) {
      logger.warn(
        `[WakeAndUnlock] failed to read recorded credential for ${this.device.deviceId}: ${error}`,
      );
      return null;
    }
  }

  private async rememberLock(lockType: DeviceLockType, credential: string | null): Promise<void> {
    if (!this.credentialStore) {
      return;
    }
    try {
      await this.credentialStore.rememberLock(this.device.deviceId, lockType, credential);
    } catch (error) {
      // Best-effort persistence: failing to remember must not fail the unlock the
      // caller actually asked for.
      logger.warn(`[WakeAndUnlock] failed to remember lock for ${this.device.deviceId}: ${error}`);
    }
  }

  private async supportsKeyCombination(): Promise<boolean> {
    if (this.keyCombinationSupported !== undefined) {
      return this.keyCombinationSupported;
    }
    const apiLevel = await readAndroidDeviceApiLevel(this.adb);
    this.keyCombinationSupported =
      apiLevel !== null && apiLevel >= ANDROID_KEYCOMBINATION_MIN_API_LEVEL;
    return this.keyCombinationSupported;
  }
}
