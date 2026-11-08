import { BaseActionResult } from "./BaseActionResult";

/** Host-rendered Back affordance a Car App Library template Back press tapped (#17498). */
export type TemplateHostBackAffordance = "toolbar_nav_icon" | "primary_header_action";

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
  /**
   * Set when BACK changed nothing on a Car App Library template and the press fell back to
   * tapping the templates host's own Back affordance instead (#17498).
   */
  backFallback?: TemplateHostBackAffordance;
}
