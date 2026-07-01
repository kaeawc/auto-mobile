import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a long press operation
 */
export interface LongPressResult extends BaseActionResult {
  x: number;
  y: number;
  pressRecognized?: boolean;
  contextMenuOpened?: boolean;
  selectionStarted?: boolean;
}
