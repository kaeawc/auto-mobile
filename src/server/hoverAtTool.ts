import { z } from "zod/v4";
import type { BootedDevice } from "../models";
import { HoverAt } from "../features/action/HoverAt";
import type { ProgressCallback } from "./toolRegistry";
import { resolveTransportDeadlineMs } from "./formTools";
import { hierarchyLayerSchema } from "../models/elementSelectorSchemas";
import {
  addDeviceTargetingToSchema,
  responseShapeControlFields,
  withJsonSchemaOverride,
} from "../utils/schemaHelpers";
import {
  DRAG_PATH_DEFAULT_SEGMENT_MS,
  DRAG_PATH_MAX_POINTS,
  DRAG_PATH_SEGMENT_MAX_MS,
  DRAG_PATH_SEGMENT_MIN_MS,
} from "../features/action/dragPathPlan";
import { createStructuredToolResponse, type StructuredToolResponse } from "../utils/toolUtils";

const hoverPointSchema = z
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
    distance: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        "Stylus hover distance from the surface: 0 touching, 1 farthest. Stylus only; a mouse has none",
      ),
  })
  .strict();

type HoverAtValue = {
  points: Array<{ x: number; y: number; distance?: number }>;
  coordinateSpace?: "absolute" | "normalized" | "percent";
  toolType?: "stylus" | "mouse";
};

function validateHoverAtValue(value: HoverAtValue, context: z.RefinementCtx): void {
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
    if (value.toolType === "mouse" && point.distance !== undefined) {
      context.addIssue({
        code: "custom",
        message: "distance applies to a stylus hover; a mouse has none",
        path: ["points", index, "distance"],
      });
    }
  }
}

export const hoverAtSchema = withJsonSchemaOverride(
  // Refined after the device-targeting fields are added: extending a refined object drops the check.
  addDeviceTargetingToSchema(
    z
      .object({
        points: z
          .array(hoverPointSchema)
          .min(1)
          .max(DRAG_PATH_MAX_POINTS)
          .describe(
            "Hover positions: the pointer enters at the first, moves through the rest and exits at the last. No contact is made",
          ),
        toolType: z
          .enum(["stylus", "mouse"])
          .optional()
          .describe(
            "Pointer that hovers (default stylus). Apps see a different tool type and source: a stylus hover reports TOOL_TYPE_STYLUS with a hover distance, a mouse hover reports TOOL_TYPE_MOUSE",
          ),
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
        ...responseShapeControlFields,
      })
      .strict(),
  ).superRefine(validateHoverAtValue),
  (js) => {
    js.description =
      "Hover a stylus or mouse over a path of points with no contact: hover enter, move and exit (Android, needs the hover_input_v1 capability or, for a stylus, a root adb shell; refused on iOS and otherwise, never turned into a touch).";
  },
);

export async function hoverAtHandler(
  device: BootedDevice,
  args: z.infer<typeof hoverAtSchema>,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  const result = await new HoverAt(device).execute(
    {
      points: args.points,
      toolType: args.toolType,
      coordinateSpace: args.coordinateSpace,
      display: args.display,
      snapshotId: args.snapshotId,
      layer: args.layer,
    },
    { progress, signal, deadlineMs: resolveTransportDeadlineMs(args) },
  );
  const message = result.success
    ? `Hovered over ${args.points.length} point${args.points.length === 1 ? "" : "s"} (${result.plannedDurationMs} ms planned, via ${result.route})`
    : `Failed to hover: ${result.error || "unknown error"}`;
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
