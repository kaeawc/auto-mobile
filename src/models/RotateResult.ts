import { BaseActionResult } from "./BaseActionResult";

/**
 * Whether Android automatic rotation is disabled, enabled, or could not be
 * confirmed after a rotation operation.
 */
export type OrientationLockState = "locked" | "unlocked" | "unknown";

/**
 * Result of a rotate operation
 */
export interface RotateResult extends BaseActionResult {
  orientation: string;
  value: number;

  // Enhanced fields for intelligent rotation
  currentOrientation?: string;
  previousOrientation?: string;
  rotationPerformed?: boolean;
  orientationLockHandled?: boolean;
  /**
   * Android automatic-rotation state after the operation. A persistent
   * rotation succeeds only when this is confirmed as "locked".
   */
  orientationLockState?: OrientationLockState;
  message?: string;
  warning?: string;
}
