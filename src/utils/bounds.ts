import { ElementBounds } from "../models/ElementBounds";

export function isElementBounds(value: unknown): value is ElementBounds {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<ElementBounds>;
  return (
    typeof candidate.left === "number" &&
    typeof candidate.top === "number" &&
    typeof candidate.right === "number" &&
    typeof candidate.bottom === "number"
  );
}

export function parseBoundsString(boundsString: string): ElementBounds | null {
  if (!boundsString) {
    return null;
  }

  const match = boundsString.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!match) {
    return null;
  }

  return {
    left: parseInt(match[1], 10),
    top: parseInt(match[2], 10),
    right: parseInt(match[3], 10),
    bottom: parseInt(match[4], 10),
  };
}

export function parseBounds(value: unknown): ElementBounds | null {
  if (isElementBounds(value)) {
    return value;
  }

  if (typeof value === "string") {
    return parseBoundsString(value);
  }

  return null;
}

export function boundsEqual(a: ElementBounds, b: ElementBounds): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/**
 * True when every edge of the two rects differs by at most epsilonPx (screen px).
 */
export function boundsNearlyEqual(a: ElementBounds, b: ElementBounds, epsilonPx: number): boolean {
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
