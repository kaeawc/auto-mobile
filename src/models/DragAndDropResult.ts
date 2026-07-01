import { BaseActionResult } from "./BaseActionResult";

export interface DragAndDropResult extends BaseActionResult {
  duration: number;
  distance: number;
  a11yTotalTimeMs?: number;
  a11yGestureTimeMs?: number;
}
