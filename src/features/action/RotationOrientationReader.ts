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
const SETTLE_WAIT_MAX_ATTEMPTS = 3;
export const SETTLE_WAIT_POLL_INTERVAL_MS = 150;
const SETTLE_WAIT_STABLE_READS = 2;

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
      return lastStreakCount >= SETTLE_WAIT_STABLE_READS ? lastConfirmed.value : null;
    }
    return lastConfirmed.achieved !== null ? lastConfirmed.value : null;
  }

  async readLiveRotationWithSettleWait(
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
    for (let attempt = 1; attempt <= SETTLE_WAIT_MAX_ATTEMPTS; attempt++) {
      lastValue = await this.readLiveRotation(signal);
      lastAchieved =
        lastValue === null ? null : await this.orientationOfRotation(lastValue, signal);
      this.updateOrientationStreak(lastAchieved, streak);
      if (lastAchieved !== null && streak.count >= SETTLE_WAIT_STABLE_READS) {
        lastConfirmed.value = lastValue;
        lastConfirmed.achieved = lastAchieved;
        // A single matching sample is not proof the orientation is held —
        // require it to hold across a second, later sample before accepting
        // it, rather than returning on the very first read (#6211 review).
        if (lastAchieved === requestedOrientation) {
          return lastValue;
        }
      }
      if (attempt < SETTLE_WAIT_MAX_ATTEMPTS) {
        await awaitWhileRequestIsLive(this.ctx().timer.sleep(SETTLE_WAIT_POLL_INTERVAL_MS), signal);
      }
    }
    return this.resolveExhaustedSettleWait(lastAchieved, streak.count, lastConfirmed);
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
