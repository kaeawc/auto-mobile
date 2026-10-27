import type { RotateResult } from "../../models";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { throwIfAborted } from "../../utils/toolUtils";
import type { RotationOrientationReader } from "./RotationOrientationReader";
import type { RotationSettingsStore } from "./RotationSettingsStore";
import {
  ROTATION_RETURN_CONFIRMATION_TIMEOUT_MS,
  type RotationCallSettings,
  type RotationContext,
} from "./RotationSupport";

/** Confirms the live Android orientation after the complete observation epilogue. */
export class RotationEndConfirmation {
  constructor(
    private readonly ctx: () => Pick<RotationContext, "timer">,
    private readonly reader: Pick<RotationOrientationReader, "orientationOfRotation">,
    private readonly store: Pick<RotationSettingsStore, "rollbackUserRotation">,
    private readonly readLiveRotation: (signal?: AbortSignal) => Promise<number | null>,
  ) {}

  private async readRotationAtReturn(options: { signal?: AbortSignal }): Promise<number | null> {
    const { signal } = options;
    try {
      const rotation = await raceWithDeadline(() => this.readLiveRotation(signal), {
        timer: this.ctx().timer,
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

  async confirmAndroidOrientationAtReturn(options: {
    result: RotateResult;
    orientation: "portrait" | "landscape";
    signal?: AbortSignal;
    settings?: RotationCallSettings;
    restoreOnFailure: (result: RotateResult) => Promise<RotateResult>;
  }): Promise<RotateResult> {
    const { result, orientation, signal, settings, restoreOnFailure } = options;
    if (!result.success || result.currentOrientation !== orientation) {
      return result;
    }
    // Read after the complete observation epilogue: its hierarchy rotation may
    // be cached, and the sensor can revert a direct rotation while it runs.
    const rotation = await this.readRotationAtReturn({ signal });
    if (rotation === null) {
      const warning = `The end-of-call orientation could not be confirmed (live rotation read failed); the requested ${orientation} orientation may not be held.`;
      const failed = {
        ...result,
        success: false,
        error: warning,
        currentOrientation: "unknown",
        warning: [result.warning, warning].filter(Boolean).join(" "),
        message: warning,
      };
      return restoreOnFailure(failed);
    }
    const actual = await this.reader.orientationOfRotation(rotation, signal);
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
    const error = `${cause} The device is in ${actual} at the time the call returned. Pass lockOrientation: true to keep the requested orientation.`;
    // The sensor undid the rotation, so the user_rotation this call wrote would only flip the
    // screen the next time rotation is locked (#14955): put the prior value back.
    const rollbackWarning = settings?.started
      ? await this.store.rollbackUserRotation({
          previous: settings.previousUserRotation,
          written: settings.writtenUserRotation,
          signal,
        })
      : undefined;
    const warning = [result.warning, rollbackWarning].filter(Boolean).join(" ") || undefined;
    const failed = {
      ...result,
      success: false,
      currentOrientation: actual,
      error,
      message: error,
      ...(warning ? { warning } : {}),
    };
    return restoreOnFailure(failed);
  }
}
