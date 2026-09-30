export interface DragAndDropTarget {
  text?: string;
  elementId?: string;
}

export interface DragAndDropOptions {
  display?: string;
  source: DragAndDropTarget;
  target: DragAndDropTarget;
  pressDurationMs?: number;
  dragDurationMs?: number;
  holdDurationMs?: number;
}
