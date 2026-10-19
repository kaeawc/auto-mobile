import { z } from "zod/v4";
import { addDeviceTargetingToSchema, responseShapeControlFields } from "../utils/schemaHelpers";

/** Shared by tapAt and hitTest; only the action schema opts into extras. */
export const coordinatePointInputSchema = () =>
  addDeviceTargetingToSchema(
    z
      .object({
        display: z.string().optional().describe("Target panel key, role, or active"),
        snapshotId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Short-lived reference from observe.snapshotReference; reject stale geometry or frame context",
          ),
        x: z
          .number()
          .describe("Screen x coordinate in the selected coordinateSpace (native by default)"),
        y: z
          .number()
          .describe("Screen y coordinate in the selected coordinateSpace (native by default)"),
        coordinateSpace: z
          .enum(["absolute", "normalized", "percent"])
          .optional()
          .describe(
            "Coordinate units: native absolute (default), normalized 0–1, or percent 0–100",
          ),
        raw: responseShapeControlFields.raw,
        project: responseShapeControlFields.project,
      })
      .strict(),
  );

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
