import type { ElementContainerSelector } from "./PinchOnOptions";
import type { ElementSelectionStrategy } from "./ElementSelectionStrategy";

export interface DragAndDropTarget {
  text?: string;
  elementId?: string;
  container?: ElementContainerSelector;
  selectionStrategy?: ElementSelectionStrategy;
}

export interface DragAndDropOptions {
  display?: string;
  source: DragAndDropTarget;
  target: DragAndDropTarget;
  pressDurationMs?: number;
  dragDurationMs?: number;
  holdDurationMs?: number;
}
