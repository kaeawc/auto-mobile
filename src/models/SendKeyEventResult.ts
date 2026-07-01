import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a send key event operation
 */
export interface SendKeyEventResult extends BaseActionResult {
  keyCode: number | string;
}
