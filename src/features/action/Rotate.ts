import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { unsupportedPlatformError } from "../../models/ActionableError";
import { Mutex } from "async-mutex";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BaseVisualChange } from "./BaseVisualChange";
import { BootedDevice, ObserveResult, OrientationLockState, RotateResult } from "../../models";
import { logger } from "../../utils/logger";
import { ProgressCallback } from "./BaseVisualChange";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { IOSCtrlProxyClient } from "../observe/ios";
import { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import { readWindowManagerRotation } from "../../utils/android-cmdline-tools/readWindowManagerRotation";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { verifyIosRotation } from "./iosRotateVerification";
import { ROTATION_READ_FLOOR_MS } from "../observe/Idle";
import {
  orientationFromRotation,
  readNaturalLandscape,
  rotationForOrientation,
} from "./OrientationReader";

export interface RotationRestoreState {
  accelerometerRotation: 0 | 1 | null;
  userRotation: number | null;
}

export interface RotationRestoreSlot {
  get(): RotationRestoreState | undefined;
  record(state: RotationRestoreState): void;
  clear(): void;
}

export interface RotateOptions {
  deadlineMs?: number;
  sessionRotation?: <T>(mutation: (slot?: RotationRestoreSlot) => Promise<T>) => Promise<T>;
}

interface RotationCallSettings {
  previousUserRotation: number | null;
  started: boolean;
  writtenUserRotation: number | null;
  beforeWrite(options?: {
    accelerometerRotation?: boolean;
    captureUserRotation?: boolean;
    userRotation?: number;
  }): Promise<void>;
}

interface RotationSettingCleanup {
  assertCurrentDevice?: () => void;
  pendingWrite?: Promise<unknown>;
  needed: boolean;
}

const ROTATION_SETTING_CLEANUP_TIMEOUT_MS = 1000;
const ROTATION_RETURN_CONFIRMATION_TIMEOUT_MS = 1000;

type AlreadyAppliedOrientationDecision =
  | { kind: "handled"; result: RotateResult }
  | {
      kind: "requires-rotation";
      reason: "orientation-differs" | "live-rotation-unavailable" | "live-orientation-changed";
    };

interface AndroidRotationResultOptions {
  orientation: "portrait" | "landscape";
  value: number;
  currentOrientation: string;
  achievedOrientation: string;
  warning: string | undefined;
  restoreConfirmed: boolean;
  preserveLock: boolean;
  restoreAutomaticRotation: boolean;
  wasAutoRotateEnabled: boolean;
  signal?: AbortSignal;
}

export class Rotate extends BaseVisualChange {
  // Serializes the read-auto-rotate -> disable -> rotate -> restore-auto-rotate
  // critical section per device, so two concurrent rotations against the SAME
  // device cannot interleave: without this, one rotation could read the
  // other's temporary `accelerometer_rotation=0` as the "prior state" and
  // later restore auto-rotate to the wrong value (#6199 review). Keyed by
  // deviceId (not per-instance) since a new Rotate is constructed per tool
  // call. Deliberately NOT shared across different devices.
  private static readonly rotationLocks = new Map<string, Mutex>();

  // Bounded settle-wait for the post-restore confirmation read (#6211). When
  // the device is physically held opposite the requested orientation,
  // WindowManager takes a moment to settle after `accelerometer_rotation` is
  // restored, so an immediate read can catch a transient value and report a
  // spurious "unconfirmed"/reverted result. The converse is just as real: a
  // FIRST sample that already matches the requested orientation is not proof
  // it is held — the physical sensor can swing it away moments later — so a
  // match is only accepted once it reads the same way on a second,
  // subsequent sample. Retry a few times, on the injected Timer, before
  // accepting the read as final (#6211 review).
  private static readonly SETTLE_WAIT_MAX_ATTEMPTS = 3;
  private static readonly SETTLE_WAIT_POLL_INTERVAL_MS = 150;
  private static readonly SETTLE_WAIT_STABLE_READS = 2;

  // The active display's natural orientation, read once per Android call so every
  // rotation <-> orientation conversion in that call agrees. Only set while a call
  // is running and dropped when it ends: a fold or unfold changes the active panel
  // and its natural axes, so it must never carry over to the next call.
  private callNaturalLandscape: { value: boolean | null } | undefined;
  private callScoped = false;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    timer: Timer = defaultTimer,
    private readonly options: RotateOptions = {},
  ) {
    super(device, adb, timer);
  }

  /** Natural orientation of the active display (the rule shared with AndroidOrientationReader). */
  private async readNaturalAxes(signal?: AbortSignal): Promise<boolean | null> {
    if (this.callNaturalLandscape) {
      return this.callNaturalLandscape.value;
    }
    throwIfAborted(signal);
    const value = await awaitWhileRequestIsLive(readNaturalLandscape(this.adb, signal), signal);
    throwIfAborted(signal);
    if (this.callScoped) {
      this.callNaturalLandscape = { value };
    }
    return value;
  }

  private async orientationOfRotation(
    rotation: number,
    signal?: AbortSignal,
  ): Promise<"portrait" | "landscape"> {
    return orientationFromRotation(rotation, await this.readNaturalAxes(signal)) ?? "landscape";
  }

  private getRotationLock(): Mutex {
    let lock = Rotate.rotationLocks.get(this.device.deviceId);
    if (!lock) {
      lock = new Mutex();
      Rotate.rotationLocks.set(this.device.deviceId, lock);
    }
    return lock;
  }

  /**
   * Get the current device orientation
   * @returns Promise with current orientation ("portrait" or "landscape")
   */
  private async readSystemSetting(key: string, signal?: AbortSignal): Promise<string | null> {
    throwIfAborted(signal);
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.device);
      const a11yResult = await awaitWhileRequestIsLive(
        a11y.requestSettingsGet("system", key),
        signal,
      );
      if (a11yResult.success) {
        return a11yResult.found ? (a11yResult.value ?? null) : null;
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.debug(`[Rotate] a11y settings get failed for ${key}: ${error}`);
    }
    throwIfAborted(signal);
    try {
      const result = await awaitWhileRequestIsLive(
        this.adb.executeCommand(`shell settings get system ${key}`),
        signal,
      );
      const out = result.stdout.trim();
      return !out || out === "null" ? null : out;
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`Failed to read system setting ${key}: ${error}`);
      return null;
    }
  }

  /** Restore recorded settings through the same CtrlProxy-first/ADB fallback as rotation. */
  async restoreRotationSettings(state: RotationRestoreState, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await this.getRotationLock().runExclusive(() => this.writeRotationSettings({ state, signal }));
  }

  private async writeRotationSettings(options: {
    state: RotationRestoreState;
    signal?: AbortSignal;
    assertCurrentDevice?: () => void;
  }): Promise<void> {
    const { state, signal, assertCurrentDevice } = options;
    const cleanup: RotationSettingCleanup = { needed: false, assertCurrentDevice };
    // No observation or device discovery is needed for a settings-only restoration.
    // Teardown drains admitted mutations before restoring; late setup hands off after writes settle.
    await runWithAbortSignal(signal, async () => {
      if (state.userRotation !== null) {
        await this.writeSystemSetting("user_rotation", String(state.userRotation), signal, cleanup);
      }
      if (state.accelerometerRotation !== null) {
        await this.writeSystemSetting(
          "accelerometer_rotation",
          String(state.accelerometerRotation),
          signal,
          cleanup,
        );
      }
      for (const [key, expected] of [
        ["user_rotation", state.userRotation],
        ["accelerometer_rotation", state.accelerometerRotation],
      ] as const) {
        if (expected !== null && (await this.readSystemSetting(key, signal)) !== String(expected)) {
          throw new ActionableError(
            `Restoration of ${key}=${expected} did not verify by read-back.`,
          );
        }
      }
    });
  }

  private async readUserRotation(signal?: AbortSignal): Promise<number | null> {
    const raw = await this.readSystemSetting("user_rotation", signal);
    if (raw === null || raw.trim() === "") {
      return null;
    }
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  }

  private async rollbackUserRotation(options: {
    previous: number | null;
    written: number | null;
    signal?: AbortSignal;
    slot?: RotationRestoreSlot;
  }): Promise<string | undefined> {
    const { previous, written, signal, slot } = options;
    if (written === null || signal?.aborted || previous === null) {
      return;
    }
    try {
      slot?.get();
      const current = await this.readUserRotation(signal);
      if (current !== written) {
        return "Skipped user_rotation rollback: its current value no longer matches this call's write (another actor may have changed it).";
      }
      if (current === previous) {
        return;
      }
      await raceWithDeadline(
        () =>
          this.writeRotationSettings({
            state: { userRotation: previous, accelerometerRotation: null },
            signal,
            assertCurrentDevice: () => {
              slot?.get();
            },
          }),
        {
          timer: this.timer,
          timeoutMs: ROTATION_SETTING_CLEANUP_TIMEOUT_MS,
          signal,
          label: "Rollback user_rotation",
        },
      );
    } catch (error) {
      logger.warn("Failed to roll back user_rotation after rotation failure", error);
      return `Failed to roll back user_rotation: ${error}`;
    }
  }

  private async completeSessionRestore(
    result: RotateResult,
    lockOrientation: boolean | undefined,
    slot?: RotationRestoreSlot,
    signal?: AbortSignal,
  ): Promise<RotateResult> {
    if (lockOrientation !== false || result.orientationLockState !== "unlocked" || !slot) {
      return result;
    }
    const state = slot.get();
    if (!state) {
      return result;
    }
    try {
      await raceWithDeadline(
        () =>
          this.writeRotationSettings({
            state: { userRotation: state.userRotation, accelerometerRotation: null },
            signal,
            assertCurrentDevice: () => {
              slot.get();
            },
          }),
        {
          timer: this.timer,
          timeoutMs: ROTATION_SETTING_CLEANUP_TIMEOUT_MS,
          signal,
          label: "Restore original user_rotation",
        },
      );
      // Explicit unlock applies immediately; retain the first originals until
      // release/rebind so a subsequent rotate cannot redefine the session baseline.
    } catch (error) {
      logger.warn(
        "Failed to restore original user_rotation after explicit automatic rotation",
        error,
      );
      result.warning = [result.warning, `Failed to restore original user_rotation: ${error}`]
        .filter(Boolean)
        .join(" ");
    }
    return result;
  }

  /**
   * Read display 0's live rotation from `dumpsys window displays`.
   * Unlike the `user_rotation` setting, this reflects the rotation actually
   * applied by the sensor when auto-rotate is on, so it cannot go stale the
   * way `user_rotation` does (issue #6129). Parsing is delegated to
   * {@link readWindowManagerRotation}, which attributes the authoritative
   * rotation to display 0 and skips stale/unrelated `mRotation=` occurrences
   * (e.g. a cached TaskSnapshot) elsewhere in the dump (issue #6199).
   * @returns The parsed rotation value, or null if it could not be read
   */
  private async readLiveRotation(signal?: AbortSignal): Promise<number | null> {
    throwIfAborted(signal);
    try {
      const deadlineMs = this.options.deadlineMs;
      const readOptions =
        deadlineMs === undefined
          ? { signal }
          : { signal, timeoutMs: Math.max(deadlineMs - this.timer.now(), ROTATION_READ_FLOOR_MS) };
      return await awaitWhileRequestIsLive(
        readWindowManagerRotation(this.adb, readOptions),
        signal,
      );
    } catch (error) {
      throwIfAborted(signal);
      logger.warn("[Rotate] Failed to read live rotation via dumpsys window", error);
      return null;
    }
  }

  /**
   * Read the live rotation after restoring auto-rotate, with a bounded
   * settle-wait: WindowManager can take a moment to settle after
   * `accelerometer_rotation` is restored, particularly when the device is
   * physically held opposite the requested orientation, so an immediate read
   * can catch a transient value. Retry (on the injected Timer) until the
   * live read matches the requested orientation or the attempt budget is
   * exhausted, returning the last read either way so the caller can report
   * it honestly (#6211).
   */
  /**
   * Update an in-progress consecutive-match streak with a newly read
   * orientation. A `null` (unreadable) sample always breaks the streak
   * rather than extending or restarting it — it is a read failure, not a
   * confirming or contradicting orientation sample.
   */
  private updateOrientationStreak(
    achieved: "portrait" | "landscape" | null,
    streak: { achieved: "portrait" | "landscape" | null; count: number },
  ): void {
    if (achieved !== null && achieved === streak.achieved) {
      streak.count++;
    } else {
      streak.achieved = achieved;
      streak.count = achieved === null ? 0 : 1;
    }
  }

  /**
   * Decide the settle-wait's return value once the attempt budget is
   * exhausted without the requested orientation ever reaching the stability
   * threshold (#6211 review).
   */
  private resolveExhaustedSettleWait(
    lastAchieved: "portrait" | "landscape" | null,
    lastStreakCount: number,
    lastConfirmed: { value: number | null; achieved: "portrait" | "landscape" | null },
  ): number | null {
    // A lone final sample, whether it matches the requested orientation or
    // contradicts it, has no opportunity for a confirming later sample. Do
    // not turn that unsettled observation into either a definitive success or
    // a definitive reversion. A later non-null sample supersedes an earlier
    // confirmed streak unless that later sample completes its own confirmed
    // streak. An unreadable final sample leaves the earlier confirmed streak
    // as the newest trustworthy evidence.
    if (lastAchieved !== null) {
      return lastStreakCount >= Rotate.SETTLE_WAIT_STABLE_READS ? lastConfirmed.value : null;
    }
    return lastConfirmed.achieved !== null ? lastConfirmed.value : null;
  }

  private async readLiveRotationWithSettleWait(
    requestedOrientation: "portrait" | "landscape",
    signal?: AbortSignal,
  ): Promise<number | null> {
    throwIfAborted(signal);
    let lastValue: number | null = null;
    let lastAchieved: "portrait" | "landscape" | null = null;
    // Tracks consecutive matching samples for whichever orientation was last
    // read — not only the requested one — so a confirmed opposite-orientation
    // reversion (e.g. two consecutive landscape samples when portrait was
    // requested) is remembered in `lastConfirmed` even though it never
    // triggers the early-return below (#6211 review).
    const streak: { achieved: "portrait" | "landscape" | null; count: number } = {
      achieved: null,
      count: 0,
    };
    const lastConfirmed: { value: number | null; achieved: "portrait" | "landscape" | null } = {
      value: null,
      achieved: null,
    };
    for (let attempt = 1; attempt <= Rotate.SETTLE_WAIT_MAX_ATTEMPTS; attempt++) {
      lastValue = await this.readLiveRotation(signal);
      lastAchieved =
        lastValue === null ? null : await this.orientationOfRotation(lastValue, signal);
      this.updateOrientationStreak(lastAchieved, streak);
      if (lastAchieved !== null && streak.count >= Rotate.SETTLE_WAIT_STABLE_READS) {
        lastConfirmed.value = lastValue;
        lastConfirmed.achieved = lastAchieved;
        // A single matching sample is not proof the orientation is held —
        // require it to hold across a second, later sample before accepting
        // it, rather than returning on the very first read (#6211 review).
        if (lastAchieved === requestedOrientation) {
          return lastValue;
        }
      }
      if (attempt < Rotate.SETTLE_WAIT_MAX_ATTEMPTS) {
        await awaitWhileRequestIsLive(
          this.timer.sleep(Rotate.SETTLE_WAIT_POLL_INTERVAL_MS),
          signal,
        );
      }
    }
    return this.resolveExhaustedSettleWait(lastAchieved, streak.count, lastConfirmed);
  }

  /**
   * Compose the post-restore confirmation warning. The wording must stay
   * state-neutral (never assert "auto-rotate is enabled") whenever the
   * restore write itself did not confirm success — otherwise the composed
   * warning contradicts the ambiguity note appended by the caller when
   * `restoreWriteError` is set (#6211 review).
   */
  private buildConfirmationWarning(
    requestedOrientation: "portrait" | "landscape",
    restoreConfirmed: boolean,
    achievedOrientation: "portrait" | "landscape" | null,
  ): string | undefined {
    if (achievedOrientation === requestedOrientation) {
      return undefined;
    }
    if (achievedOrientation === null) {
      return restoreConfirmed
        ? `Auto-rotate is enabled and the device's orientation after restoring it could not be confirmed (live rotation read failed); the requested ${requestedOrientation} orientation may not be held.`
        : `The device's orientation after attempting to restore auto-rotate could not be confirmed (live rotation read failed); the requested ${requestedOrientation} orientation may not be held.`;
    }
    return restoreConfirmed
      ? `Auto-rotate is enabled and immediately reverted the device to ${achievedOrientation} based on the physical sensor; the requested ${requestedOrientation} orientation is not held.`
      : `The device reverted to ${achievedOrientation} after attempting to restore auto-rotate; the requested ${requestedOrientation} orientation is not held.`;
  }

  /**
   * After restoring auto-rotate, determine what orientation the device
   * actually ended up in. Restoring auto-rotate can let the physical sensor
   * immediately re-apply its own orientation, overriding the one just
   * forced, so this confirmation read MUST be LIVE (mRotation from dumpsys
   * window) — falling back to `user_rotation` here would just echo the
   * value this same call wrote a moment ago and silently recreate the false
   * "requested orientation held" success this fix exists to prevent. The
   * read goes through a bounded settle-wait (#6211) so a momentarily
   * unsettled WindowManager doesn't yield a spurious "unconfirmed"/reverted
   * result. If the live read is still unavailable after settling, the
   * achieved orientation is reported as unconfirmed rather than guessed
   * (#6199 review). `restoreConfirmed` controls whether the composed warning
   * may assert "auto-rotate is enabled" (#6211 review).
   */
  private async confirmOrientationAfterAutoRotateRestore(
    requestedOrientation: "portrait" | "landscape",
    restoreConfirmed: boolean,
    signal?: AbortSignal,
  ): Promise<{ achievedOrientation: string; warning: string | undefined }> {
    throwIfAborted(signal);
    const liveRotationValue = await this.readLiveRotationWithSettleWait(
      requestedOrientation,
      signal,
    );
    if (liveRotationValue === null) {
      return {
        achievedOrientation: "unknown",
        warning: this.buildConfirmationWarning(requestedOrientation, restoreConfirmed, null),
      };
    }

    const achievedOrientation = await this.orientationOfRotation(liveRotationValue, signal);
    return {
      achievedOrientation,
      warning: this.buildConfirmationWarning(
        requestedOrientation,
        restoreConfirmed,
        achievedOrientation,
      ),
    };
  }

  /**
   * Restore auto-rotate (previously forced off to apply an explicit
   * rotation) and determine the actual achieved orientation. A REJECTED
   * restore write does NOT prove auto-rotate stayed disabled: the underlying
   * put can time out AFTER CtrlProxy already applied it but before
   * broadcasting the result, so auto-rotate may in fact be back on and the
   * physical sensor may already have reverted the device. The live
   * orientation is therefore always re-confirmed afterward — the same way a
   * successful restore is confirmed — rather than assumed either way, and
   * the ambiguity (when present) is folded into the returned warning so the
   * caller can report the TRUE state (#6211 review).
   */
  private async restoreAutoRotateAndConfirmOrientation(
    requestedOrientation: "portrait" | "landscape",
    signal?: AbortSignal,
    cleanup: RotationSettingCleanup = { needed: false },
  ): Promise<{
    achievedOrientation: string;
    warning: string | undefined;
    restoreConfirmed: boolean;
  }> {
    let restoreWriteError: unknown;
    try {
      await this.restoreAutoRotateSetting(cleanup);
    } catch (firstError) {
      // A single transient failure (e.g. a momentary CtrlProxy/ADB hiccup)
      // must not be treated as ambiguous on its own — retry once, the same
      // idempotent write, before falling back to the ambiguous-outcome path
      // (#6211 review).
      logger.debug(
        `[Rotate] accelerometer_rotation restore write failed on first attempt, retrying once: ${firstError}`,
      );
      try {
        await this.restoreAutoRotateSetting(cleanup);
      } catch (retryError) {
        restoreWriteError = retryError;
        logger.warn(
          `[Rotate] accelerometer_rotation restore write failed after retry (ambiguous outcome) after confirming rotation to ${requestedOrientation}: ${retryError}`,
        );
      }
    }

    if (signal?.aborted && restoreWriteError !== undefined) {
      throw new ActionableError(
        "Rotation cancelled; accelerometer_rotation may be left changed (auto-rotate may remain disabled)",
        { cause: restoreWriteError },
      );
    }
    const restoreConfirmed = restoreWriteError === undefined;
    const { achievedOrientation, warning: confirmWarning } =
      await this.confirmOrientationAfterAutoRotateRestore(
        requestedOrientation,
        restoreConfirmed,
        signal,
      );
    if (restoreConfirmed) {
      return { achievedOrientation, warning: confirmWarning, restoreConfirmed };
    }

    const ambiguityNote = `the accelerometer_rotation restore write failed after a retry (ambiguous outcome — could not confirm whether auto-rotate was actually re-enabled): ${restoreWriteError}`;
    const warning = confirmWarning
      ? `${confirmWarning} Additionally, ${ambiguityNote}`
      : `Rotated to ${requestedOrientation}, but ${ambiguityNote}`;
    return { achievedOrientation, warning, restoreConfirmed };
  }

  /**
   * Describe the rotation outcome without treating an unconfirmed restore as
   * proof that auto-rotate caused the final orientation. The orientation read
   * itself remains evidence and is retained in the message.
   */
  private buildRotationMessage(
    requestedOrientation: "portrait" | "landscape",
    previousOrientation: string,
    achievedOrientation: string,
    warning: string | undefined,
    restoreConfirmed: boolean,
  ): string {
    if (!warning) {
      return `Successfully rotated from ${previousOrientation} to ${requestedOrientation}`;
    }
    if (!restoreConfirmed) {
      if (achievedOrientation === "unknown") {
        return `Rotated to ${requestedOrientation}, but after attempting to restore auto-rotate, the device's current orientation could not be confirmed`;
      }
      if (achievedOrientation === requestedOrientation) {
        return `Rotated to ${requestedOrientation}; after attempting to restore auto-rotate, the device was confirmed to remain ${achievedOrientation}`;
      }
      return `Rotated to ${requestedOrientation}; after attempting to restore auto-rotate, the device was confirmed ${achievedOrientation}`;
    }
    if (achievedOrientation === "unknown") {
      return `Rotated to ${requestedOrientation}, but the device's orientation after auto-rotate restore could not be confirmed`;
    }
    if (achievedOrientation !== requestedOrientation) {
      return `Rotated to ${requestedOrientation}, but auto-rotate reverted the device to ${achievedOrientation}`;
    }
    return `Successfully rotated from ${previousOrientation} to ${requestedOrientation}`;
  }

  async getCurrentOrientation(signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    // Prefer the live window-manager rotation: `user_rotation` only reflects
    // the last explicitly-requested rotation and goes stale as soon as
    // auto-rotate applies a sensor-driven rotation on top of it (#6129).
    const liveRotation = await this.readLiveRotation(signal);
    if (liveRotation !== null) {
      return this.orientationOfRotation(liveRotation, signal);
    }

    const userRotationStr = await this.readSystemSetting("user_rotation", signal);

    if (!userRotationStr || !/^\d+$/.test(userRotationStr)) {
      logger.warn(`Invalid user_rotation value: ${userRotationStr}, defaulting to portrait`);
      return "portrait";
    }

    const userRotation = parseInt(userRotationStr, 10);

    return this.orientationOfRotation(userRotation, signal);
  }

  /**
   * Read the `accelerometer_rotation` setting as a tri-state: "locked" and
   * "enabled" are CONFIRMED readings, "unknown" means the setting was absent,
   * unreadable, or malformed. Callers must not treat "unknown" as either
   * confirmed state — in particular, auto-rotate must only be restored after
   * a rotation when it was CONFIRMED enabled beforehand (#6199 review).
   * @returns "locked" (auto-rotation disabled), "enabled" (auto-rotation on),
   *   or "unknown" when the setting could not be confirmed
   */
  private async getAutoRotateState(
    signal?: AbortSignal,
  ): Promise<"locked" | "enabled" | "unknown"> {
    throwIfAborted(signal);
    const val = await this.readSystemSetting("accelerometer_rotation", signal);
    if (val === null || !/^\d+$/.test(val)) {
      return "unknown";
    }
    // 0 = locked (auto-rotation disabled), 1 = unlocked (auto-rotation enabled)
    return parseInt(val, 10) === 0 ? "locked" : "enabled";
  }

  private async getOrientationLockState(signal?: AbortSignal): Promise<OrientationLockState> {
    throwIfAborted(signal);
    const autoRotateState = await this.getAutoRotateState(signal);
    if (autoRotateState === "unknown") {
      return "unknown";
    }
    return autoRotateState === "locked" ? "locked" : "unlocked";
  }

  private async lockAlreadyAppliedOrientation(
    orientation: "portrait" | "landscape",
    value: number,
    currentOrientation: string,
    options: { beforeWrite: RotationCallSettings["beforeWrite"]; cleanup: RotationSettingCleanup },
    signal?: AbortSignal,
  ): Promise<AlreadyAppliedOrientationDecision> {
    throwIfAborted(signal);
    const { beforeWrite, cleanup } = options;
    const liveRotation = await this.readLiveRotation(signal);
    if (liveRotation === null) {
      // The normal rotation path can still establish the requested orientation
      // when the exact live rotation is temporarily unavailable.
      return { kind: "requires-rotation", reason: "live-rotation-unavailable" };
    }
    const liveOrientation = await this.orientationOfRotation(liveRotation, signal);
    if (liveOrientation !== orientation) {
      // The display changed after the initial read; perform a normal requested
      // rotation instead of locking a now-opposite orientation.
      return { kind: "requires-rotation", reason: "live-orientation-changed" };
    }

    // Capture both originals before the first write; an unreadable session
    // baseline is a structured failure, never an unrestorable mutation.
    await beforeWrite({ accelerometerRotation: true, captureUserRotation: true });
    try {
      // Android applies user_rotation when auto-rotate is disabled. Persist
      // the exact live value before the lock so stale settings cannot rotate
      // an already-matching (including reverse) display.
      await beforeWrite({ userRotation: liveRotation });
      await this.writeSystemSetting("user_rotation", String(liveRotation), signal, cleanup);
      await beforeWrite();
      await this.writeSystemSetting("accelerometer_rotation", "0", signal, cleanup);
      await this.awaitIdle.waitForRotation(liveRotation, undefined, signal);
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`Failed to lock the current ${orientation} orientation: ${error}`, error);
      return {
        kind: "handled",
        result: {
          success: false,
          orientation,
          value,
          currentOrientation,
          previousOrientation: currentOrientation,
          rotationPerformed: false,
          orientationLockHandled: false,
          orientationLockState: await this.getOrientationLockState(signal),
          error: `Failed to lock the device in its current ${orientation} orientation: ${error}`,
        },
      };
    }

    const orientationLockState = await this.getOrientationLockState(signal);
    const confirmedRotation = await this.readLiveRotation(signal);
    if (orientationLockState !== "locked" || confirmedRotation !== liveRotation) {
      const achievedOrientation =
        confirmedRotation === null
          ? "unknown"
          : await this.orientationOfRotation(confirmedRotation, signal);
      return {
        kind: "handled",
        result: {
          success: false,
          orientation,
          value,
          currentOrientation: achievedOrientation,
          previousOrientation: currentOrientation,
          rotationPerformed: false,
          orientationLockHandled: false,
          orientationLockState,
          error: `Device was already in ${orientation} orientation, but its exact locked rotation could not be confirmed (auto-rotate is ${orientationLockState}).`,
        },
      };
    }

    return {
      kind: "handled",
      result: {
        success: true,
        orientation,
        value,
        currentOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed: false,
        orientationLockHandled: true,
        orientationLockState,
        message: `Locked device orientation to ${orientation}.`,
      },
    };
  }

  private shouldReturnAlreadyAppliedOrientation(
    preserveLock: boolean,
    restoreAutomaticRotation: boolean,
    initialOrientationLockState: OrientationLockState,
  ): boolean {
    return (
      (preserveLock && initialOrientationLockState === "locked") ||
      (restoreAutomaticRotation && initialOrientationLockState === "unlocked") ||
      (!preserveLock && !restoreAutomaticRotation)
    );
  }

  private async handleAlreadyAppliedOrientation(
    orientation: "portrait" | "landscape",
    value: number,
    currentOrientation: string,
    autoRotateState: "locked" | "enabled" | "unknown",
    plan: {
      preserveLock: boolean;
      restoreAutomaticRotation: boolean;
      beforeWrite: RotationCallSettings["beforeWrite"];
      cleanup: RotationSettingCleanup;
    },
    signal?: AbortSignal,
  ): Promise<AlreadyAppliedOrientationDecision> {
    throwIfAborted(signal);
    const { preserveLock, restoreAutomaticRotation, beforeWrite, cleanup } = plan;
    if (currentOrientation !== orientation) {
      return { kind: "requires-rotation", reason: "orientation-differs" };
    }

    const initialOrientationLockState: OrientationLockState =
      autoRotateState === "locked"
        ? "locked"
        : autoRotateState === "enabled"
          ? "unlocked"
          : "unknown";
    if (
      this.shouldReturnAlreadyAppliedOrientation(
        preserveLock,
        restoreAutomaticRotation,
        initialOrientationLockState,
      )
    ) {
      return {
        kind: "handled",
        result: {
          success: true,
          orientation,
          value,
          currentOrientation,
          previousOrientation: currentOrientation,
          rotationPerformed: false,
          orientationLockHandled: false,
          orientationLockState: initialOrientationLockState,
          message: `Device is already in ${orientation} orientation`,
        },
      };
    }

    if (preserveLock) {
      return this.lockAlreadyAppliedOrientation(
        orientation,
        value,
        currentOrientation,
        { beforeWrite, cleanup },
        signal,
      );
    }

    if (!restoreAutomaticRotation) {
      return { kind: "requires-rotation", reason: "orientation-differs" };
    }

    await beforeWrite({ accelerometerRotation: true });
    const { achievedOrientation, warning } = await this.restoreAutoRotateAndConfirmOrientation(
      orientation,
      signal,
      cleanup,
    );
    const orientationLockState = await this.getOrientationLockState(signal);
    if (orientationLockState !== "unlocked") {
      return {
        kind: "handled",
        result: {
          success: false,
          orientation,
          value,
          currentOrientation: achievedOrientation,
          previousOrientation: currentOrientation,
          rotationPerformed: false,
          orientationLockHandled: true,
          orientationLockState,
          error: `Automatic rotation could not be confirmed as restored (orientation lock is ${orientationLockState}).`,
        },
      };
    }
    return {
      kind: "handled",
      result: {
        success: true,
        orientation,
        value,
        currentOrientation: achievedOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed: false,
        orientationLockHandled: true,
        orientationLockState,
        warning,
        message: `Restored automatic rotation; device is currently ${achievedOrientation}.`,
      },
    };
  }

  private resolveAutoRotatePlan(
    autoRotateState: "locked" | "enabled" | "unknown",
    lockOrientation: boolean | undefined,
    sessionMode = false,
  ): {
    preserveLock: boolean;
    restoreAutomaticRotation: boolean;
    wasAutoRotateEnabled: boolean;
    shouldRestoreAutoRotate: boolean;
    canForceAutoRotateOff: boolean;
  } {
    const preserveLock =
      lockOrientation === true ||
      (sessionMode && lockOrientation === undefined && autoRotateState !== "unknown");
    const restoreAutomaticRotation = lockOrientation === false;
    const wasAutoRotateEnabled = autoRotateState === "enabled";
    return {
      preserveLock,
      restoreAutomaticRotation,
      wasAutoRotateEnabled,
      shouldRestoreAutoRotate: restoreAutomaticRotation || (wasAutoRotateEnabled && !preserveLock),
      // The default preserves the #6199 guard against mutating an
      // unconfirmed setting. Explicit requests deliberately own the
      // resulting state, so they can force auto-rotate off first.
      canForceAutoRotateOff: lockOrientation !== undefined || autoRotateState !== "unknown",
    };
  }

  private logAutoRotatePlan(
    autoRotateState: "locked" | "enabled" | "unknown",
    preserveLock: boolean,
    restoreAutomaticRotation: boolean,
  ): void {
    if (preserveLock) {
      logger.info("Keeping the requested orientation locked after rotation");
    } else if (restoreAutomaticRotation) {
      logger.info("Rotating before explicitly restoring automatic rotation");
    } else if (autoRotateState === "locked") {
      logger.info("Orientation is locked; forcing the requested rotation");
    } else if (autoRotateState === "enabled") {
      logger.info("Auto-rotate is on; temporarily disabling it to force rotation");
    } else {
      logger.info(
        "accelerometer_rotation is unreadable; setting user_rotation only, without forcing accelerometer_rotation (no confirmed prior state to restore)",
      );
    }
  }

  private async finalizeAndroidRotation(
    options: AndroidRotationResultOptions,
  ): Promise<RotateResult> {
    const {
      orientation,
      value,
      currentOrientation,
      achievedOrientation,
      warning,
      restoreConfirmed,
      preserveLock,
      restoreAutomaticRotation,
      wasAutoRotateEnabled,
      signal,
    } = options;
    throwIfAborted(signal);
    const orientationLockState = await this.getOrientationLockState(signal);
    const rotationPerformed = currentOrientation !== orientation;
    if (preserveLock && orientationLockState !== "locked") {
      // Auto-rotate may already have restored the sensor-held orientation.
      // Reuse the bounded live read; stale user_rotation cannot confirm it.
      const confirmation = await this.confirmOrientationAfterAutoRotateRestore(
        orientation,
        false,
        signal,
      );
      return {
        success: false,
        orientation,
        value,
        currentOrientation: confirmation.achievedOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed,
        orientationLockHandled: false,
        orientationLockState,
        error: `${rotationPerformed ? `Rotated to ${orientation}` : `Device is already in ${orientation} orientation`}, but the persistent orientation lock could not be confirmed (auto-rotate is ${orientationLockState}).`,
      };
    }
    if (restoreAutomaticRotation && orientationLockState !== "unlocked") {
      return {
        success: false,
        orientation,
        value,
        currentOrientation: achievedOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed,
        orientationLockHandled: true,
        orientationLockState,
        error: `Rotated to ${orientation}, but automatic rotation could not be confirmed as restored (orientation lock is ${orientationLockState}).`,
      };
    }
    if (achievedOrientation !== "unknown" && achievedOrientation !== orientation) {
      const cause = restoreConfirmed
        ? "auto-rotate reverted it"
        : `after attempting to restore auto-rotate, it was confirmed ${achievedOrientation}; auto-rotate may have reverted it`;
      const error = `Requested ${orientation}, but the device is actually in ${achievedOrientation}; ${cause}. Pass lockOrientation: true to keep the requested ${orientation} orientation.`;
      return {
        success: false,
        orientation,
        value,
        currentOrientation: achievedOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed: achievedOrientation !== currentOrientation,
        orientationLockHandled: wasAutoRotateEnabled,
        orientationLockState,
        warning,
        error,
        message: error,
      };
    }
    return {
      success: true,
      orientation,
      value,
      currentOrientation: achievedOrientation,
      previousOrientation: currentOrientation,
      rotationPerformed,
      orientationLockHandled: wasAutoRotateEnabled,
      orientationLockState,
      warning,
      message: rotationPerformed
        ? this.buildRotationMessage(
            orientation,
            currentOrientation,
            achievedOrientation,
            warning,
            restoreConfirmed,
          )
        : `Locked device orientation to ${orientation}.`,
    };
  }

  /**
   * Check if orientation is locked
   * @returns Promise with boolean indicating if auto-rotation is disabled
   */
  async isOrientationLocked(signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    return (await this.getAutoRotateState(signal)) === "locked";
  }

  private async restoreAutoRotateSetting(cleanup: RotationSettingCleanup): Promise<void> {
    await raceWithDeadline(
      () =>
        runWithAbortSignal(undefined, async () => {
          if (cleanup.pendingWrite) {
            try {
              await cleanup.pendingWrite;
            } catch (error) {
              // A failed write may have applied; its settlement still orders the restore.
              logger.warn("[Rotate] Pending setting write failed before cleanup", error);
            }
          }
          await this.writeSystemSetting("accelerometer_rotation", "1", undefined, cleanup);
          cleanup.needed = false;
        }),
      {
        timer: this.timer,
        timeoutMs: ROTATION_SETTING_CLEANUP_TIMEOUT_MS,
        label: "Restore accelerometer_rotation=1",
      },
    );
  }

  private async writeSystemSetting(
    key: string,
    value: string,
    signal?: AbortSignal,
    cleanup?: RotationSettingCleanup,
  ): Promise<void> {
    throwIfAborted(signal);
    cleanup?.assertCurrentDevice?.();
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.device);
      cleanup?.assertCurrentDevice?.();
      const write = a11y.requestSettingsPut("system", key, value, "int");
      if (cleanup) {
        cleanup.pendingWrite = write;
      }
      const a11yResult = await awaitWhileRequestIsLive(write, signal);
      if (a11yResult.success) {
        return;
      }
      logger.debug(`[Rotate] a11y settings put failed for ${key}: ${a11yResult.error}`);
    } catch (error) {
      throwIfAborted(signal);
      logger.debug(`[Rotate] a11y settings put threw for ${key}: ${error}`);
    }
    throwIfAborted(signal);
    cleanup?.assertCurrentDevice?.();
    const write = this.adb.executeCommand(`shell settings put system ${key} ${value}`);
    if (cleanup) {
      cleanup.pendingWrite = write;
    }
    await awaitWhileRequestIsLive(write, signal);
  }

  async execute(
    orientation: "portrait" | "landscape",
    progress?: ProgressCallback,
    lockOrientation?: boolean,
    signal?: AbortSignal,
    display = 0,
  ): Promise<RotateResult> {
    throwIfAborted(signal);
    const perf = createGlobalPerformanceTracker();
    perf.serial("rotate");

    try {
      switch (this.device.platform) {
        case "ios":
          if (display !== 0) {
            throw new ActionableError(
              "Selecting a non-default display for rotate is supported only on Android devices.",
            );
          }
          return await this.executeIosRotation(orientation, progress, perf, signal);
        case "android":
          if (display !== 0) {
            const rotation = rotationForOrientation(
              orientation,
              await readNaturalLandscape(this.adb, signal),
            );
            const mode = lockOrientation === false ? "free" : "lock";
            await this.adb.executeCommand(
              `shell cmd window user-rotation -d ${display} ${mode} ${rotation}`,
            );
            return {
              success: true,
              orientation,
              value: rotation,
              currentOrientation: orientation,
              rotationPerformed: true,
              message: `Rotated display ${display} to ${orientation}`,
            };
          }
          return await this.executeAndroidRotation(
            orientation,
            progress,
            perf,
            lockOrientation,
            signal,
          );
        default:
          throw unsupportedPlatformError(this.device.platform, "rotate the device");
      }
    } catch (error) {
      throw toActionableError(
        error,
        signal?.aborted
          ? "Rotation cancelled; device may still complete the change"
          : "Failed to rotate device",
      );
    }
  }

  private async executeIosRotation(
    orientation: "portrait" | "landscape",
    progress: ProgressCallback | undefined,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    signal?: AbortSignal,
  ): Promise<RotateResult> {
    throwIfAborted(signal);
    let previousObservation: ObserveResult | undefined;
    const result: RotateResult = await this.observedInteraction(
      async (observation) => {
        previousObservation = observation;
        try {
          throwIfAborted(signal);
          const client = IOSCtrlProxyClient.getInstance(this.device);
          const result = await perf.track("iOSRotation", () =>
            awaitWhileRequestIsLive(client.requestRotate(orientation, 5000, perf), signal),
          );

          if (!result.success) {
            return {
              success: false,
              orientation,
              value: orientation === "portrait" ? 0 : 1,
              error: result.error ?? "Failed to rotate iOS device",
              currentOrientation: result.currentOrientation,
              previousOrientation: result.previousOrientation,
              rotationPerformed: result.rotationPerformed,
            };
          }

          return {
            success: true,
            orientation,
            value: result.value,
            currentOrientation: result.currentOrientation,
            previousOrientation: result.previousOrientation,
            rotationPerformed: result.rotationPerformed,
            orientationLockHandled: false,
            message: result.rotationPerformed
              ? `Successfully rotated from ${result.previousOrientation} to ${result.currentOrientation}`
              : `Device is already in ${orientation} orientation`,
          };
        } catch (error) {
          throwIfAborted(signal);
          throw toActionableError(error, "Failed to rotate iOS device");
        }
      },
      {
        // The runner can report a successful no-op. A hierarchy diff is not
        // evidence that its screen rotated, and a no-op needs no visual change.
        usesObservationForResolution: false,
        changeExpected: false,
        timeoutMs: 5000,
        progress,
        perf,
        signal,
        skipUiStability: true,
      },
    );
    return verifyIosRotation(result, orientation, previousObservation);
  }

  private async executeAndroidRotation(
    orientation: "portrait" | "landscape",
    progress: ProgressCallback | undefined,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    lockOrientation: boolean | undefined,
    signal?: AbortSignal,
  ): Promise<RotateResult> {
    throwIfAborted(signal);
    this.callScoped = true;
    this.callNaturalLandscape = undefined;
    try {
      return await this.runAndroidRotation(orientation, progress, perf, lockOrientation, signal);
    } finally {
      this.callScoped = false;
      this.callNaturalLandscape = undefined;
    }
  }

  private async runAndroidRotation(
    orientation: "portrait" | "landscape",
    progress: ProgressCallback | undefined,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    lockOrientation: boolean | undefined,
    signal?: AbortSignal,
  ): Promise<RotateResult> {
    const observationOptions = {
      usesObservationForResolution: false,
      changeExpected: true,
      timeoutMs: 5000,
      progress,
      perf,
      signal,
      // Rotation animations are incorrectly detected as unstable by gfxinfo.
      skipUiStability: true,
    };
    const result: RotateResult = await this.observedInteraction(
      // The read-auto-rotate -> disable -> rotate -> restore-auto-rotate
      // sequence below must run atomically per device: interleaving it with
      // a concurrent rotation on the same device would let one call observe
      // the other's temporary accelerometer_rotation=0 as the "prior state"
      // (#6199 review). Different devices use independent locks and never
      // wait on each other.
      async () => {
        const acquisition = this.getRotationLock().acquire();
        let release: () => void;
        try {
          release = await awaitWhileRequestIsLive(acquisition, signal);
        } catch (error) {
          // Cancelled waiters must release their eventual acquisition without dispatching.
          void acquisition.then((unlock) => unlock());
          throw toActionableError(error, "Could not acquire the device rotation lock");
        }
        try {
          const mutation = (slot?: RotationRestoreSlot) =>
            this.performAndroidRotation(orientation, perf, lockOrientation, signal, slot);
          const result = this.options.sessionRotation
            ? await this.options.sessionRotation(mutation)
            : await mutation();
          // Decide from the completed action under the lock, not a racy pre-read.
          // Successful no-ops still receive a fresh observation without requiring a diff.
          if (result.success && result.rotationPerformed === false) {
            observationOptions.changeExpected = false;
          }
          return result;
        } finally {
          release();
        }
      },
      observationOptions,
    );
    return this.confirmAndroidOrientationAtReturn({ result, orientation, signal });
  }

  private async readRotationAtReturn(options: { signal?: AbortSignal }): Promise<number | null> {
    const { signal } = options;
    try {
      const rotation = await raceWithDeadline(() => this.readLiveRotation(signal), {
        timer: this.timer,
        timeoutMs: ROTATION_RETURN_CONFIRMATION_TIMEOUT_MS,
        signal,
        label: "Confirm end-of-call rotation",
      });
      throwIfAborted(signal);
      return rotation;
    } catch (error) {
      throwIfAborted(signal);
      logger.warn("[Rotate] Failed to confirm end-of-call orientation", error);
      return null;
    }
  }

  private async confirmAndroidOrientationAtReturn(options: {
    result: RotateResult;
    orientation: "portrait" | "landscape";
    signal?: AbortSignal;
  }): Promise<RotateResult> {
    const { result, orientation, signal } = options;
    if (!result.success || result.currentOrientation !== orientation) {
      return result;
    }
    // Read after the complete observation epilogue: its hierarchy rotation may
    // be cached, and the sensor can revert a direct rotation while it runs.
    const rotation = await this.readRotationAtReturn({ signal });
    if (rotation === null) {
      const warning = `The end-of-call orientation could not be confirmed (live rotation read failed); the requested ${orientation} orientation may not be held.`;
      return {
        ...result,
        currentOrientation: "unknown",
        warning: [result.warning, warning].filter(Boolean).join(" "),
        message: warning,
      };
    }
    const actual = await this.orientationOfRotation(rotation, signal);
    if (actual === orientation) {
      return result;
    }
    const confirmed =
      result.rotationPerformed === false
        ? `was already in ${orientation}`
        : `rotated to ${orientation}`;
    const cause =
      result.orientationLockState === "unlocked"
        ? `The device ${confirmed} and then returned to ${actual} because automatic rotation is on.`
        : `The device left the requested ${orientation} orientation after the call confirmed it.`;
    const error = `${cause} The device is in ${actual} at the time the call returned. Pass lockOrientation: true, or use a device session, to keep the requested orientation.`;
    return { ...result, success: false, currentOrientation: actual, error, message: error };
  }

  private async captureSessionRotationOriginals(options: {
    state: RotationRestoreState;
    captureAccelerometer: boolean;
    captureUser: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const { state, captureAccelerometer, captureUser, signal } = options;
    // Retry only originals for settings this path will change. Unknown,
    // untouched auto-rotate still preserves the direct-mode #6199 guard.
    if (captureAccelerometer && state.accelerometerRotation === null) {
      const retry = await this.getAutoRotateState(signal);
      if (retry === "unknown") {
        throw new ActionableError(
          "The current rotation setting accelerometer_rotation could not be read; retry rotation when settings are readable.",
        );
      }
      state.accelerometerRotation = retry === "locked" ? 0 : 1;
    }
    if (captureUser && state.userRotation === null) {
      const retry = await this.readUserRotation(signal);
      if (retry === null) {
        throw new ActionableError(
          "The current rotation setting user_rotation could not be read; retry rotation when settings are readable.",
        );
      }
      state.userRotation = retry;
    }
  }

  private rotationCallSettings(
    autoRotateState: "locked" | "enabled" | "unknown",
    slot?: RotationRestoreSlot,
    signal?: AbortSignal,
  ): RotationCallSettings {
    const accelerometerRotation =
      autoRotateState === "locked" ? 0 : autoRotateState === "enabled" ? 1 : null;
    const settings: RotationCallSettings = {
      previousUserRotation: null,
      started: false,
      writtenUserRotation: null,
      beforeWrite: async (options = {}) => {
        const original = slot?.get(); // Retirement fences every admitted write.
        if (!settings.started) {
          settings.previousUserRotation = await this.readUserRotation(signal);
        }
        const state = original ?? {
          accelerometerRotation,
          userRotation: settings.previousUserRotation,
        };
        if (slot) {
          await this.captureSessionRotationOriginals({
            state,
            captureAccelerometer: options.accelerometerRotation === true,
            captureUser: options.captureUserRotation === true || options.userRotation !== undefined,
            signal,
          });
          if (!settings.started && settings.previousUserRotation === null) {
            settings.previousUserRotation = state.userRotation;
          }
          throwIfAborted(signal);
          slot.get();
          if (!original) {
            slot.record(state);
          }
        }
        settings.started = true;
        if (options.userRotation !== undefined) {
          settings.writtenUserRotation = options.userRotation;
        }
      },
    };
    return settings;
  }

  private async finishAndroidRotation(
    result: RotateResult,
    settings: RotationCallSettings,
    lockOrientation: boolean | undefined,
    slot?: RotationRestoreSlot,
    signal?: AbortSignal,
  ): Promise<RotateResult> {
    if (
      settings.started &&
      !result.success &&
      result.currentOrientation !== "unknown" &&
      result.currentOrientation !== result.orientation
    ) {
      const warning = await this.rollbackUserRotation({
        previous: settings.previousUserRotation,
        written: settings.writtenUserRotation,
        signal,
        slot,
      });
      result.warning = [result.warning, warning].filter(Boolean).join(" ") || undefined;
    }
    return this.completeSessionRestore(result, lockOrientation, slot, signal);
  }

  /**
   * The read-auto-rotate -> disable -> rotate -> restore-auto-rotate critical
   * section for Android rotation. Callers MUST run this under
   * {@link getRotationLock} to serialize it per device (#6199 review).
   */
  private async performAndroidRotation(
    orientation: "portrait" | "landscape",
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    lockOrientation: boolean | undefined,
    signal?: AbortSignal,
    slot?: RotationRestoreSlot,
  ): Promise<RotateResult> {
    throwIfAborted(signal);
    // Read the natural axes first so the requested value and every orientation read agree.
    const value = rotationForOrientation(orientation, await this.readNaturalAxes(signal));

    // Run getCurrentOrientation and getAutoRotateState in parallel
    const [currentOrientation, autoRotateState] = await perf.track("getOrientationState", () =>
      Promise.all([this.getCurrentOrientation(signal), this.getAutoRotateState(signal)]),
    );

    const settings = this.rotationCallSettings(autoRotateState, slot, signal);
    const plan = this.resolveAutoRotatePlan(autoRotateState, lockOrientation, slot !== undefined);
    const {
      preserveLock,
      restoreAutomaticRotation,
      wasAutoRotateEnabled,
      shouldRestoreAutoRotate,
      canForceAutoRotateOff,
    } = plan;
    const cleanup: RotationSettingCleanup = {
      needed: false,
      assertCurrentDevice: () => {
        slot?.get();
      },
    };
    const alreadyApplied = await this.handleAlreadyAppliedOrientation(
      orientation,
      value,
      currentOrientation,
      autoRotateState,
      { preserveLock, restoreAutomaticRotation, beforeWrite: settings.beforeWrite, cleanup },
      signal,
    );
    if (alreadyApplied.kind === "handled") {
      return this.finishAndroidRotation(
        alreadyApplied.result,
        settings,
        lockOrientation,
        slot,
        signal,
      );
    }
    logger.debug(
      `[Rotate] Continuing with requested rotation: ${alreadyApplied.reason.replaceAll("-", " ")}`,
    );

    // Auto-rotate must be off for `user_rotation` writes to take effect,
    // regardless of whether it was already off beforehand. Remember the
    // pre-existing value so it can be restored once the forced rotation
    // completes, instead of leaving auto-rotate permanently disabled
    // (#6129). An explicit persistent request takes ownership of this state,
    // while explicit false restores automatic rotation even after a previous
    // persistent request.

    try {
      this.logAutoRotatePlan(autoRotateState, preserveLock, restoreAutomaticRotation);

      await perf.track("setRotation", async () => {
        await settings.beforeWrite({
          accelerometerRotation: canForceAutoRotateOff,
          captureUserRotation: true,
        });
        if (canForceAutoRotateOff) {
          // user_rotation is honored only after automatic rotation is disabled.
          // Keeping these writes ordered avoids a target write racing ahead of
          // the lock on devices where the settings provider completes slowly.
          throwIfAborted(signal);
          cleanup.needed = shouldRestoreAutoRotate && autoRotateState !== "locked";
          await this.writeSystemSetting("accelerometer_rotation", "0", signal, cleanup);
        } else {
          logger.debug(
            "[Rotate] accelerometer_rotation is unconfirmed; writing user_rotation without changing the lock state",
          );
        }
        await settings.beforeWrite({ userRotation: value });
        await this.writeSystemSetting("user_rotation", String(value), signal, cleanup);
      });

      // Wait for rotation to complete (also serves as verification)
      await perf.track("waitForRotation", () =>
        this.awaitIdle.waitForRotation(value, undefined, signal),
      );

      // Note: We skip explicit verification since waitForRotation already confirms
      // the rotation completed successfully by polling dumpsys window

      // waitForRotation(value) above already confirmed the device reached the
      // requested orientation while auto-rotate was forced off. The local
      // `currentOrientation` remains the legitimate prior value (see #6057).
      let achievedOrientation: string = orientation;
      let warning: string | undefined;
      let restoreConfirmed = true;

      if (shouldRestoreAutoRotate) {
        ({ achievedOrientation, warning, restoreConfirmed } =
          await this.restoreAutoRotateAndConfirmOrientation(orientation, signal, cleanup));
      }

      const result = await this.finalizeAndroidRotation({
        orientation,
        value,
        currentOrientation,
        achievedOrientation,
        warning,
        restoreConfirmed,
        preserveLock,
        restoreAutomaticRotation,
        wasAutoRotateEnabled,
        signal,
      });
      return this.finishAndroidRotation(result, settings, lockOrientation, slot, signal);
    } catch (error) {
      return this.recoverAndroidRotation({
        error,
        orientation,
        value,
        currentOrientation,
        settings,
        cleanup,
        plan,
        lockOrientation,
        slot,
        signal,
      });
    }
  }

  private async confirmAndroidRotationAfterError(options: {
    orientation: "portrait" | "landscape";
    settings: RotationCallSettings;
    slot?: RotationRestoreSlot;
    signal?: AbortSignal;
  }): Promise<{ achievedOrientation: string; warning?: string }> {
    const { orientation, settings, slot, signal } = options;
    if (settings.writtenUserRotation === null) {
      return { achievedOrientation: "unknown" };
    }
    try {
      slot?.get();
      const liveRotation = await raceWithDeadline(
        () => this.readLiveRotationWithSettleWait(orientation, signal),
        {
          timer: this.timer,
          timeoutMs: ROTATION_SETTING_CLEANUP_TIMEOUT_MS,
          signal,
          label: "Confirm rotation after error",
        },
      );
      if (liveRotation !== null) {
        return {
          achievedOrientation: await this.orientationOfRotation(liveRotation, signal),
        };
      }
      return {
        achievedOrientation: "unknown",
        warning:
          "Orientation is unconfirmed; user_rotation was left unchanged because the rotation outcome is unknown.",
      };
    } catch (error) {
      logger.warn("Failed to confirm orientation after rotation error", error);
      return { achievedOrientation: "unknown", warning: `Orientation is unconfirmed: ${error}` };
    }
  }

  private async restoreAutoRotateAfterError(options: {
    settings: RotationCallSettings;
    cleanup: RotationSettingCleanup;
    shouldRestoreAutoRotate: boolean;
    signal?: AbortSignal;
  }): Promise<ActionableError | undefined> {
    const { settings, cleanup, shouldRestoreAutoRotate, signal } = options;
    // Restore temporary/explicit-unlock operations, including cancelled pending
    // writes. Persistent requests retain their lock; retirement fences cleanup.
    let restoreFailure: ActionableError | undefined;
    if (signal?.aborted ? cleanup.needed : settings.started && shouldRestoreAutoRotate) {
      try {
        await this.restoreAutoRotateSetting(cleanup);
        logger.info("Restored auto-rotate after error");
      } catch (error) {
        logger.warn("Failed to restore auto-rotate", error);
        restoreFailure = toActionableError(error, "Failed to restore auto-rotate");
      }
    }
    if (signal?.aborted && restoreFailure) {
      throw new ActionableError(
        "Rotation cancelled; accelerometer_rotation may be left changed (auto-rotate may remain disabled)",
        { cause: restoreFailure },
      );
    }
    throwIfAborted(signal);
    return restoreFailure;
  }

  private async recoverAndroidRotation(options: {
    error: unknown;
    orientation: "portrait" | "landscape";
    value: number;
    currentOrientation: string;
    settings: RotationCallSettings;
    cleanup: RotationSettingCleanup;
    plan: ReturnType<Rotate["resolveAutoRotatePlan"]>;
    lockOrientation?: boolean;
    slot?: RotationRestoreSlot;
    signal?: AbortSignal;
  }): Promise<RotateResult> {
    const {
      error,
      orientation,
      value,
      currentOrientation,
      settings,
      cleanup,
      plan,
      lockOrientation,
      slot,
      signal,
    } = options;
    const {
      shouldRestoreAutoRotate,
      preserveLock,
      restoreAutomaticRotation,
      wasAutoRotateEnabled,
    } = plan;
    logger.warn("Failed to change device orientation", error);
    if (!settings.started && error instanceof ActionableError) {
      throw error;
    }
    const restoreFailure = await this.restoreAutoRotateAfterError({
      settings,
      cleanup,
      shouldRestoreAutoRotate,
      signal,
    });
    const confirmation = await this.confirmAndroidRotationAfterError({
      orientation,
      settings,
      slot,
      signal,
    });
    const { achievedOrientation } = confirmation;
    let { warning } = confirmation;
    if (achievedOrientation === orientation) {
      const result = await this.finalizeAndroidRotation({
        orientation,
        value,
        currentOrientation,
        achievedOrientation,
        warning: [
          restoreFailure?.message,
          `Rotation was confirmed after an earlier error: ${error}`,
        ]
          .filter(Boolean)
          .join(" "),
        restoreConfirmed: !restoreFailure,
        preserveLock,
        restoreAutomaticRotation,
        wasAutoRotateEnabled,
        signal,
      });
      return this.finishAndroidRotation(result, settings, lockOrientation, slot, signal);
    }
    if (achievedOrientation !== "unknown" && achievedOrientation !== orientation) {
      const rollbackWarning = await this.rollbackUserRotation({
        previous: settings.previousUserRotation,
        written: settings.writtenUserRotation,
        signal,
        slot,
      });
      warning = [warning, rollbackWarning].filter(Boolean).join(" ") || undefined;
    }
    warning = [warning, restoreFailure?.message].filter(Boolean).join(" ") || undefined;
    return {
      success: false,
      warning,
      orientation,
      value,
      currentOrientation: achievedOrientation,
      previousOrientation: currentOrientation,
      rotationPerformed: false,
      orientationLockHandled: wasAutoRotateEnabled,
      orientationLockState: await this.getOrientationLockState(signal),
      error: `Failed to change device orientation: ${error}`,
    };
  }
}
