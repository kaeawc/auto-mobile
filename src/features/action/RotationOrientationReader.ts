/**
 * RotationOrientationReader - reads the live orientation and the auto-rotate lock state.
 *
 * Extracted from Rotate (max-class-lines): natural-axes resolution, live window-manager rotation
 * reads and the bounded settle-wait that confirms the orientation after auto-rotate is restored.
 */

import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { OrientationLockState } from "../../models";
import { logger } from "../../utils/logger";
import { readWindowManagerRotation } from "../../utils/android-cmdline-tools/readWindowManagerRotation";
import { ROTATION_READ_FLOOR_MS } from "../observe/Idle";
import { orientationFromRotation, readNaturalLandscape } from "./OrientationReader";
import type { RotationContext } from "./RotationSupport";
import type { RotationSettingsStore } from "./RotationSettingsStore";

export const SETTLE_WAIT_POLL_INTERVAL_MS = 150;
export const SETTLE_HOLD_MS = 1000;
export const SETTLE_WINDOW_MS = 3000;
const SETTLE_WAIT_STABLE_READS = 2;
export interface RotationSettleProfile {
  maxAttempts: number;
  holdMs: number;
  windowMs: number;
}
export const ERROR_RECOVERY_SETTLE_PROFILE: RotationSettleProfile = {
  maxAttempts: 3,
  holdMs: 0,
  windowMs: Infinity,
};
export const POST_RESTORE_SETTLE_PROFILE: RotationSettleProfile = {
  maxAttempts: Math.ceil(SETTLE_WINDOW_MS / SETTLE_WAIT_POLL_INTERVAL_MS) + 2,
  holdMs: SETTLE_HOLD_MS,
  windowMs: SETTLE_WINDOW_MS,
};

export class RotationOrientationReader {
  // The active display's natural orientation, read once per Android call so every
  // rotation <-> orientation conversion in that call agrees. Only set while a call
  // is running and dropped when it ends: a fold or unfold changes the active panel
  // and its natural axes, so it must never carry over to the next call.
  private callNaturalLandscape: { value: boolean | null } | undefined;
  private callScoped = false;

  constructor(
    private readonly ctx: () => RotationContext,
    private readonly store: RotationSettingsStore,
  ) {}

  /** Scope the natural-axes cache to one Android call. */
  beginCall(): void {
    this.callScoped = true;
    this.callNaturalLandscape = undefined;
  }

  endCall(): void {
    this.callScoped = false;
    this.callNaturalLandscape = undefined;
  }

  /** Natural orientation of the active display (the rule shared with AndroidOrientationReader). */
  async readNaturalAxes(signal?: AbortSignal): Promise<boolean | null> {
    if (this.callNaturalLandscape) {
      return this.callNaturalLandscape.value;
    }
    throwIfAborted(signal);
    const value = await awaitWhileRequestIsLive(
      readNaturalLandscape(this.ctx().adb, signal),
      signal,
    );
    throwIfAborted(signal);
    if (this.callScoped) {
      this.callNaturalLandscape = { value };
    }
    return value;
  }

  async orientationOfRotation(
    rotation: number,
    signal?: AbortSignal,
  ): Promise<"portrait" | "landscape"> {
    return orientationFromRotation(rotation, await this.readNaturalAxes(signal)) ?? "landscape";
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
  async readLiveRotation(signal?: AbortSignal): Promise<number | null> {
    throwIfAborted(signal);
    try {
      const deadlineMs = this.ctx().deadlineMs;
      const readOptions =
        deadlineMs === undefined
          ? { signal }
          : {
              signal,
              timeoutMs: Math.max(deadlineMs - this.ctx().timer.now(), ROTATION_READ_FLOOR_MS),
            };
      return await awaitWhileRequestIsLive(
        readWindowManagerRotation(this.ctx().adb, readOptions),
        signal,
      );
    } catch (error) {
      throwIfAborted(signal);
      logger.warn("[Rotate] Failed to read live rotation via dumpsys window", error);
      return null;
    }
  }

  private updateSettleStreak(
    streak: { orientation: string | null; count: number; startedAt: number },
    achieved: string | null,
    now: number,
    holdMs: number,
  ): boolean {
    if (achieved !== null && achieved === streak.orientation) {
      streak.count++;
    } else {
      streak.orientation = achieved;
      streak.count = achieved === null ? 0 : 1;
      streak.startedAt = now;
    }
    return streak.count >= SETTLE_WAIT_STABLE_READS && now - streak.startedAt >= holdMs;
  }

  /** Requested orientation must hold continuously; opposite evidence is retained on read failure. */
  async readLiveRotationWithSettleWait(
    requestedOrientation: "portrait" | "landscape",
    signal?: AbortSignal,
    profile: RotationSettleProfile = ERROR_RECOVERY_SETTLE_PROFILE,
  ): Promise<number | null> {
    throwIfAborted(signal);
    const timer = this.ctx().timer;
    const startedAt = timer.now();
    const streak = { orientation: null as string | null, count: 0, startedAt };
    let confirmedOpposite: number | null = null;
    for (let attempt = 0; attempt < profile.maxAttempts; attempt++) {
      if (timer.now() - startedAt >= profile.windowMs) {
        break;
      }
      const value = await this.readLiveRotation(signal);
      const achieved = value === null ? null : await this.orientationOfRotation(value, signal);
      const now = timer.now();
      const held = this.updateSettleStreak(streak, achieved, now, profile.holdMs);
      // A readable newer sample supersedes prior evidence, even if it is a lone sample.
      // An unreadable tail keeps the last confirmed opposite streak trustworthy.
      if (achieved !== null) {
        confirmedOpposite =
          achieved !== requestedOrientation && streak.count >= SETTLE_WAIT_STABLE_READS
            ? value
            : null;
      }
      if (achieved === requestedOrientation && held) {
        return value;
      }
      const remaining = profile.windowMs - (now - startedAt);
      if (remaining <= 0 || attempt + 1 >= profile.maxAttempts) {
        break;
      }
      await awaitWhileRequestIsLive(
        timer.sleep(Math.min(SETTLE_WAIT_POLL_INTERVAL_MS, remaining)),
        signal,
      );
    }
    return confirmedOpposite;
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

    const userRotationStr = await this.store.readSystemSetting("user_rotation", signal);

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
  async getAutoRotateState(signal?: AbortSignal): Promise<"locked" | "enabled" | "unknown"> {
    throwIfAborted(signal);
    const val = await this.store.readSystemSetting("accelerometer_rotation", signal);
    if (val === null || !/^\d+$/.test(val)) {
      return "unknown";
    }
    // 0 = locked (auto-rotation disabled), 1 = unlocked (auto-rotation enabled)
    return parseInt(val, 10) === 0 ? "locked" : "enabled";
  }

  async getOrientationLockState(signal?: AbortSignal): Promise<OrientationLockState> {
    throwIfAborted(signal);
    const autoRotateState = await this.getAutoRotateState(signal);
    if (autoRotateState === "unknown") {
      return "unknown";
    }
    return autoRotateState === "locked" ? "locked" : "unlocked";
  }
}
