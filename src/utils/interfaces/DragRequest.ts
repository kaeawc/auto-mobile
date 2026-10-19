/**
 * One press-drag-release request. Shared by the Android and iOS CtrlProxy clients and the shared
 * gesture delegate so the three phase durations and the dispatch hooks are named, not positional.
 */
export interface DragRequest {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Time to hold before the finger starts moving. */
  pressDurationMs: number;
  /** Duration of the drag motion. */
  dragDurationMs: number;
  /** Time to hold at the destination before release. */
  holdDurationMs: number;
  /** Operation timeout. */
  timeoutMs: number;
  frameContext?: string;
  signal?: AbortSignal;
  displayId?: number;
  /** Synchronous display/stale fence run immediately before the socket write. */
  beforeSend?: () => void;
  /** Fires as the gesture is handed to the device, after the pre-send checks. */
  onDispatch?: () => void;
}
