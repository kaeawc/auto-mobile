import { BaseActionResult } from "./BaseActionResult";

export interface PinchOnResult extends BaseActionResult {
  direction: "in" | "out";
  distanceStart: number;
  distanceEnd: number;
  scale?: number;
  duration: number;
  rotationDegrees?: number;
  centerX: number;
  centerY: number;
  targetType: "screen" | "container";
  container?: {
    elementId?: string;
    text?: string;
  };
  warning?: string;
  a11yTotalTimeMs?: number;
  a11yGestureTimeMs?: number;
}
