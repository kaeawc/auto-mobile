import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a press button operation
 */
export interface PressButtonResult extends BaseActionResult {
  button: string;
  keyCode: number;
  code?: string;
  retryable?: boolean;
  dispatched?: boolean;
  acknowledged?: boolean;
}
