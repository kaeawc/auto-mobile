export interface HighlightBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  /**
   * Source units per display point, set by the daemon for the iOS simulator overlay: 1 when the
   * bounds are hierarchy points, the runner's `nativeScale` when they are screenshot pixels.
   * Absent when the daemon cannot tell; the helper then guesses the scale from the source size.
   */
  sourceScale?: number | null;
}

export interface HighlightShape {
  type: "circle";
  bounds: HighlightBounds;
}

export interface HighlightOperationResult {
  success: boolean;
  error?: string | null;
  requestId?: string;
  timestamp?: number;
}
