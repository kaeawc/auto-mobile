import type { ContainerFailure } from "./ActionableError";
import { BaseActionResult } from "./BaseActionResult";

export interface DragAndDropResult extends BaseActionResult {
  containerFailure?: ContainerFailure;
  duration: number;
  distance: number;
  a11yTotalTimeMs?: number;
  a11yGestureTimeMs?: number;
}
