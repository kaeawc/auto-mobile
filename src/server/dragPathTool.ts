import { z } from "zod/v4";
import type { BootedDevice } from "../models";
import { DragPath } from "../features/action/DragPath";
import type { ProgressCallback } from "./toolRegistry";
import { resolveTransportDeadlineMs } from "./formTools";
import { hierarchyLayerSchema } from "../models/elementSelectorSchemas";
import { pointerSchema } from "./pointerSchema";
import {
  addDeviceTargetingToSchema,
  responseShapeControlFields,
  withJsonSchemaOverride,
} from "../utils/schemaHelpers";
import { RecompositionTracker } from "../features/performance/RecompositionTracker";
import {
  DRAG_PATH_DEFAULT_SEGMENT_MS,
  DRAG_PATH_HOLD_MAX_MS,
  DRAG_PATH_MAX_POINTS,
  DRAG_PATH_MAX_TOTAL_MS,
  DRAG_PATH_MIN_POINTS,
  DRAG_PATH_SEGMENT_MAX_MS,
  DRAG_PATH_SEGMENT_MIN_MS,
} from "../features/action/dragPathPlan";
import { createStructuredToolResponse, type StructuredToolResponse } from "../utils/toolUtils";

const dragPathPointSchema = z
  .object({
    x: z.number().describe("x in the selected coordinateSpace (native by default)"),
    y: z.number().describe("y in the selected coordinateSpace (native by default)"),
    durationMs: z
      .number()
      .int()
      .min(DRAG_PATH_SEGMENT_MIN_MS)
      .max(DRAG_PATH_SEGMENT_MAX_MS)
      .optional()
      .describe(
        `Milliseconds spent moving from the previous point to this one (default ${DRAG_PATH_DEFAULT_SEGMENT_MS}); ignored on the first point`,
      ),
    pressure: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Stylus pressure 0-1 at this point (needs pointer); interpolated between points"),
    tilt: z
      .number()
      .min(0)
      .max(Math.PI / 2)
      .optional()
      .describe("Stylus tilt in radians at this point (needs pointer)"),
  })
  .strict();

type DragPathValue = {
  points: Array<{ x: number; y: number; durationMs?: number; pressure?: number; tilt?: number }>;
  pointer?: unknown;
  coordinateSpace?: "absolute" | "normalized" | "percent";
  holdMs?: number;
  releaseHoldMs?: number;
};

/** Per-point pressure and tilt describe a stylus, so they need `pointer`. */
function validateStylusPointFields(value: DragPathValue, context: z.RefinementCtx): void {
  for (const [index, point] of value.points.entries()) {
    for (const field of ["pressure", "tilt"] as const) {
      if (point[field] !== undefined && value.pointer === undefined) {
        context.addIssue({
          code: "custom",
          message: `${field} applies to a stylus; set pointer: { toolType: "stylus" }`,
          path: ["points", index, field],
        });
      }
    }
  }
}

function validateDragPathPoints(value: DragPathValue, context: z.RefinementCtx): void {
  validateStylusPointFields(value, context);
  const max =
    value.coordinateSpace === "normalized"
      ? 1
      : value.coordinateSpace === "percent"
        ? 100
        : undefined;
  for (const [index, point] of value.points.entries()) {
    for (const axis of ["x", "y"] as const) {
      const v = point[axis];
      if (!Number.isFinite(v) || v < 0 || (max !== undefined && v > max)) {
        context.addIssue({
          code: "custom",
          message:
            max === undefined
              ? `${axis} must be a finite non-negative number`
              : `${axis} must be between 0 and ${max}`,
          path: ["points", index, axis],
        });
      }
    }
  }
}

function validateDragPathValue(value: DragPathValue, context: z.RefinementCtx): void {
  validateDragPathPoints(value, context);
  const travelMs = value.points
    .slice(1)
    .reduce((sum, point) => sum + (point.durationMs ?? DRAG_PATH_DEFAULT_SEGMENT_MS), 0);
  const total = (value.holdMs ?? 0) + (value.releaseHoldMs ?? 0) + travelMs;
  if (total > DRAG_PATH_MAX_TOTAL_MS) {
    context.addIssue({
      code: "custom",
      message: `Total path duration ${total} ms exceeds the ${DRAG_PATH_MAX_TOTAL_MS} ms limit`,
      path: ["points"],
    });
  }
}

export const dragPathSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        points: z
          .array(dragPathPointSchema)
          .min(DRAG_PATH_MIN_POINTS)
          .max(DRAG_PATH_MAX_POINTS)
          .describe("Polyline vertices; the finger goes down on the first and lifts on the last"),
        holdMs: z
          .number()
          .int()
          .min(0)
          .max(DRAG_PATH_HOLD_MAX_MS)
          .optional()
          .describe("Press and hold at the first point before moving (long press, then drag)"),
        releaseHoldMs: z
          .number()
          .int()
          .min(0)
          .max(DRAG_PATH_HOLD_MAX_MS)
          .optional()
          .describe("Keep the finger down at the last point before lifting"),
        coordinateSpace: z
          .enum(["absolute", "normalized", "percent"])
          .optional()
          .describe(
            "Coordinate units: native absolute (default), normalized 0–1, or percent 0–100",
          ),
        display: z.string().optional().describe("Target panel key, role, or active"),
        snapshotId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Short-lived reference from observe.snapshotReference; reject stale geometry or frame context",
          ),
        layer: hierarchyLayerSchema.optional(),
        pointer: pointerSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ).superRefine(validateDragPathValue),
  (js) => {
    js.description =
      'Drag one finger along a polyline of points with per-segment timing, an initial hold and a release hold (Android and iOS). Use for drawing, unlock patterns, sliders, and long press then drag. With pointer: { toolType: "stylus" } it draws with a stylus (Android 12+) with per-point pressure and tilt, and is refused instead of using a finger if the device cannot.';
  },
);

export async function dragPathHandler(
  device: BootedDevice,
  args: z.infer<typeof dragPathSchema>,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  const result = await new DragPath(device).execute(
    {
      points: args.points,
      holdMs: args.holdMs,
      releaseHoldMs: args.releaseHoldMs,
      coordinateSpace: args.coordinateSpace,
      display: args.display,
      snapshotId: args.snapshotId,
      layer: args.layer,
      pointer: args.pointer,
    },
    { progress, signal, deadlineMs: resolveTransportDeadlineMs(args) },
  );
  const message = result.success
    ? `Dragged along ${args.points.length} points (${result.plannedDurationMs} ms planned, ${result.moveCount} moves)`
    : `Failed to drag along path: ${result.error || "unknown error"}`;
  const payload = {
    message,
    observation: result.observation,
    ...result,
    deviceId: device.deviceId,
    platform: device.platform,
  };
  const response: StructuredToolResponse<typeof payload> & { isError?: true } =
    createStructuredToolResponse(payload);
  return result.success ? response : { ...response, isError: true as const };
}
