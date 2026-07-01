import { Element } from "./Element";
import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of an exit dialog operation
 */
export interface ExitDialogResult extends BaseActionResult {
  elementFound: boolean;
  element?: Element;
  x?: number;
  y?: number;
}
