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
  /** How long the key was held, when the press was a long press (#16734). */
  durationMs?: number;
  acknowledged?: boolean;
}
