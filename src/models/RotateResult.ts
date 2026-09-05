import { BaseActionResult } from "./BaseActionResult";

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
  message?: string;
  warning?: string;
}
