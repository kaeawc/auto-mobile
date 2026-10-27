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
}
export { parseTouchNodes } from "./InputNodeDiscovery";
