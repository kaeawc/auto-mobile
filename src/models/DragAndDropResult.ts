import type { ContainerFailure } from "./ActionableError";
import { BaseActionResult } from "./BaseActionResult";
import type { SpringBoardDragUnsupported } from "./DragPathResult";

export interface DragAndDropResult extends BaseActionResult {
  containerFailure?: ContainerFailure;
  /** iOS: refused before any input because the source is a SpringBoard icon (#18859). */
  unsupported?: SpringBoardDragUnsupported;
  duration: number;
  distance: number;
  a11yTotalTimeMs?: number;
  a11yGestureTimeMs?: number;
}
