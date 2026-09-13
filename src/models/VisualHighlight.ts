/** The sole highlight presentation is a red, animated hand-drawn circle. */
export type HighlightShapeType = "circle";

export interface HighlightBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
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
