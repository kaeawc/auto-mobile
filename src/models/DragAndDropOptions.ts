import type { ElementQuery } from "./ElementQuery";
import type { ElementSelectionStrategy } from "./ElementSelectionStrategy";

export interface DragAndDropTarget extends ElementQuery {}

export interface DragAndDropOptions {
  selectionStrategy?: ElementSelectionStrategy;
  source: DragAndDropTarget;
  target: DragAndDropTarget;
  pressDurationMs?: number;
  dragDurationMs?: number;
  holdDurationMs?: number;
}
