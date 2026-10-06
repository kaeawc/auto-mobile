import { throwIfAborted, awaitWhileRequestIsLive } from "../toolUtils";
import { ActionableError, type BootedDevice } from "../../models";
import type {
  DeviceLockType,
  LockCredentialStore,
  WakeAndUnlockResult,
} from "../../models/WakeAndUnlock";
import { stableDeviceIdentityOf } from "../../devices/deviceIdentityEvidence";
import { logger } from "../logger";
import { defaultTimer, type Timer } from "../SystemTimer";
import { defaultAdbClientFactory, type AdbClientFactory } from "./AdbClientFactory";
import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { readAndroidDeviceApiLevel } from "./readAndroidDeviceApiLevel";
import { ANDROID_KEYCOMBINATION_MIN_API_LEVEL, buildAsciiKeyEventPlan } from "./asciiKeyEvents";

// Keep boot readiness and the feature on the same bounded keyguard recovery path.
const WAKE_SETTLE_MS = 500;
const BOUNCER_SETTLE_MS = 900;
const UNLOCK_POLL_INTERVAL_MS = 250;
const UNLOCK_POLL_MAX_MS = 2500;

export class AndroidWakeAndUnlock {
  private readonly adb: AdbExecutor;
  private readonly timer: Timer;
  private readonly credentialStore?: LockCredentialStore;
  private keyCombinationSupported: boolean | undefined;

  constructor(
    private readonly device: BootedDevice,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = defaultAdbClientFactory,
    options: { timer?: Timer; credentialStore?: LockCredentialStore } = {},
  ) {
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
  }

  async execute(pin?: string, signal?: AbortSignal): Promise<WakeAndUnlockResult> {
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
    if (!lock.keyguardShowing) {
      return {
        success: true,
        platform: "android",
        wasAsleep,
        wasLocked: false,
        secure: lock.secure,
        unlocked: true,
      };
    }
    if (!lock.locked) {
      // Showing but occluded (#10064): a show-when-locked activity (call, alarm,
      // secure camera) sits in front of a keyguard that is still up, and it is
      // back as soon as that activity finishes. Not unlocked, and no blind
      // dismissal or credential input into someone else's foreground activity.
      logger.warn("[WakeAndUnlock] keyguard is showing but occluded; unlock not attempted");
      return {
        success: false,
        platform: "android",
        wasAsleep,
        wasLocked: true,
        secure: lock.secure,
        unlocked: false,
        error:
          "Keyguard is showing but occluded by a foreground show-when-locked activity " +
          "(for example an incoming call, alarm or secure camera); the device is still locked " +
          "behind it. Finish or dismiss that activity, then call wakeAndUnlock again",
      };
    }

    // wm dismiss-keyguard dismisses a swipe lock and can raise a secure bouncer
    // (#4360), but trust/biometrics may clear a secure keyguard too. Re-check
    // before credential input rather than assuming the bouncer is still there.
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

    // Preserve cancellation during the API probe before the bouncer wait. The
    // command builder below reuses this cached capability without another read.
    await this.supportsKeyCombination(signal);
    const preEntryResult = await this.checkCredentialTarget(wasAsleep, signal);
    if (preEntryResult) {
      return preEntryResult;
    }

    const commands = await this.buildCredentialCommands(effectivePin, signal);
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

  /** Return a result if credential input is unsafe or dismissal already unlocked it. */
  private async checkCredentialTarget(
    wasAsleep: boolean,
    signal?: AbortSignal,
  ): Promise<WakeAndUnlockResult | undefined> {
    // Let dismiss-keyguard settle, then read the existing lock signals once
    // before any credential input. `secure` only says a credential is set;
    // it does not prove the keyguard still needs it (#9489).
    throwIfAborted(signal);
    await awaitWhileRequestIsLive(this.timer.sleep(BOUNCER_SETTLE_MS), signal);
    throwIfAborted(signal);
    const lock = await awaitWhileRequestIsLive(this.adb.getDeviceLock(signal), signal);
    if (lock && !lock.keyguardShowing) {
      // Dismissal already unlocked it: no credential was used or verified.
      return {
        success: true,
        platform: "android",
        wasAsleep,
        wasLocked: true,
        secure: lock.secure,
        unlocked: true,
        usedRecordedCredential: false,
      };
    }
    if (!lock || !lock.locked || lock.secure === false) {
      // An unknown/occluded/non-secure keyguard is not a safe credential target.
      logger.warn("[WakeAndUnlock] credential input skipped after keyguard re-check");
      return {
        success: false,
        platform: "android",
        wasAsleep,
        wasLocked: true,
        secure: lock?.secure,
        unlocked: false,
        usedRecordedCredential: false,
        error: !lock
          ? "Device lock state is unknown after dismiss-keyguard; credential input skipped"
          : "Keyguard is not awaiting credential input after dismiss-keyguard; unlock not verified",
      };
    }

    return undefined;
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

  /**
   * Poll the lock state until the keyguard clears or the budget expires. Cleared
   * means the keyguard is no longer *showing*: an occluded keyguard (an alarm or
   * call arriving mid-poll) is still up and must not count as unlocked (#10064).
   */
  private async pollUnlocked(signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    let elapsed = 0;
    while (elapsed < UNLOCK_POLL_MAX_MS) {
      throwIfAborted(signal);
      const lock = await awaitWhileRequestIsLive(this.adb.getDeviceLock(signal), signal);
      if (lock && !lock.keyguardShowing) {
        return true;
      }
      throwIfAborted(signal);
      await awaitWhileRequestIsLive(this.timer.sleep(UNLOCK_POLL_INTERVAL_MS), signal);
      elapsed += UNLOCK_POLL_INTERVAL_MS;
    }
    throwIfAborted(signal);
    const finalLock = await awaitWhileRequestIsLive(this.adb.getDeviceLock(signal), signal);
    return !!finalLock && !finalLock.keyguardShowing;
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
        this.credentialStore.getRecordedCredential(
          this.device.deviceId,
          stableDeviceIdentityOf(this.device),
        ),
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
        this.credentialStore.rememberLock(
          this.device.deviceId,
          lockType,
          credential,
          stableDeviceIdentityOf(this.device),
        ),
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
