import type { z } from "zod/v4";

/** Rejects a normalized (0–1) or percent (0–100) point outside its range; absolute needs no check. */
export function validateCoordinateRange(
  value: { x?: number; y?: number; coordinateSpace?: "absolute" | "normalized" | "percent" },
  context: z.RefinementCtx,
): void {
  const max =
    value.coordinateSpace === "normalized"
      ? 1
      : value.coordinateSpace === "percent"
        ? 100
        : undefined;
  if (max === undefined) {
    return;
  }
  for (const axis of ["x", "y"] as const) {
    if (
      value[axis] === undefined ||
      !Number.isFinite(value[axis]) ||
      value[axis] < 0 ||
      value[axis] > max
    ) {
      context.addIssue({
        code: "custom",
        message: `${axis} must be between 0 and ${max}`,
        path: [axis],
      });
    }
  }
}
