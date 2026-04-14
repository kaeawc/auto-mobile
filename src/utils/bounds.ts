import { ElementBounds } from "../models/ElementBounds";

export function boundsEqual(a: ElementBounds, b: ElementBounds): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/**
 * True when every edge of the two rects differs by at most epsilonPx (screen px).
 */
export function boundsNearlyEqual(
  a: ElementBounds,
  b: ElementBounds,
  epsilonPx: number
): boolean {
  const e = Math.max(0, epsilonPx);
  return (
    Math.abs(a.left - b.left) <= e &&
    Math.abs(a.top - b.top) <= e &&
    Math.abs(a.right - b.right) <= e &&
    Math.abs(a.bottom - b.bottom) <= e
  );
}

export function boundsArea(bounds: ElementBounds): number {
  return Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}
