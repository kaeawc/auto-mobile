/** Raw absolute-axis metadata reported by getevent. */
export interface AbsoluteAxisInfo {
  min: number;
  max: number;
  resolution?: number;
}

export interface TiltAxes {
  x: AbsoluteAxisInfo;
  y: AbsoluteAxisInfo;
}

/** A /dev/input/eventN node that reports multitouch position */
export interface TouchInputNode {
  path: string;
  name: string;
  axisXMin: number;
  axisXMax: number;
  axisYMin: number;
  axisYMax: number;
  /** Set by the parser on every node it returns. */
  kind: "touch" | "pen";
  /** Pressure axis range from `getevent -p`, when the node reports one. */
  pressureMin?: number;
  pressureMax?: number;
  /** Both tilt axes must be known before raw samples can be converted. */
  tiltAxes?: TiltAxes;
}
export { parseTouchNodes } from "./InputNodeDiscovery";
