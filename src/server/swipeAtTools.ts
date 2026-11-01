import { z } from "zod/v4";
import { ANSWERS_SYSTEM_ALERTS, PLAN_SKELETON } from "./toolRegistryTypes";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { SwipeAtCoordinate } from "../features/action/SwipeAtCoordinate";
import { RecompositionTracker } from "../features/performance/RecompositionTracker";
import type { BootedDevice } from "../models";
import type { SwipeAtOptions } from "../models/SwipeAtOptions";
import { swipeAtResultSchema } from "./gestureToolOutputSchemas";
import { createStructuredToolResponse, type StructuredToolResponse } from "../utils/toolUtils";
import {
  SWIPE_DURATION_MAX_MS,
  SWIPE_DURATION_MIN_MS,
  validateDurationMs,
} from "../features/action/swipeon/swipeTiming";
import { hierarchyLayerSchema } from "../models/elementSelectorSchemas";
import { imageRelativePointSchema } from "./imageRelativePointSchema";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { pointerSchema } from "./pointerSchema";
import {
  addDeviceTargetingToSchema,
  platformSchema,
  responseShapeControlFields,
  withJsonSchemaOverride,
} from "../utils/schemaHelpers";

// The handler's arguments are the parsed wire schema; its exclusivity refinement (image xor
// from/to) is narrowed where the options are built.
export type SwipeAtArgs = z.output<typeof swipeAtSchema>;

const swipeAtPointSchema = z
  .object({
    x: z.number().finite().describe("Screen x coordinate in the selected coordinateSpace"),
    y: z.number().finite().describe("Screen y coordinate in the selected coordinateSpace"),
  })
  .strict();

const imagePointSchema = z
  .object({
    x: z.number().finite().describe("x in image.unit: a 0-1 fraction or a raster pixel"),
    y: z.number().finite().describe("y in image.unit: a 0-1 fraction or a raster pixel"),
  })
  .strict();

const imageRelativeSwipeSchema = z
  .object({
    unit: imageRelativePointSchema.shape.unit,
    source: imageRelativePointSchema.shape.source,
    from: imagePointSchema.describe("Where the finger goes down, in the image"),
    to: imagePointSchema.describe("Where the finger lifts, in the image"),
  })
  .strict();

type CoordinatePair = { x: number; y: number };

function validateSwipeAtRange(
  value: { from?: CoordinatePair; to?: CoordinatePair; coordinateSpace?: string },
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
  for (const endpoint of ["from", "to"] as const) {
    for (const axis of ["x", "y"] as const) {
      const coordinate = value[endpoint]?.[axis];
      if (coordinate !== undefined && (coordinate < 0 || coordinate > max)) {
        context.addIssue({
          code: "custom",
          message: `${endpoint}.${axis} must be between 0 and ${max}`,
          path: [endpoint, axis],
        });
      }
    }
  }
}

export const swipeAtSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        snapshotId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Short-lived reference from observe.snapshotReference; reject stale geometry or frame context",
          ),
        from: swipeAtPointSchema
          .optional()
          .describe(
            "Where the finger goes down, in the selected coordinateSpace; required with to unless image is given",
          ),
        to: swipeAtPointSchema
          .optional()
          .describe(
            "Where the finger lifts, in the selected coordinateSpace; required with from unless image is given",
          ),
        coordinateSpace: z
          .enum(["absolute", "normalized", "percent"])
          .optional()
          .describe(
            "Coordinate units for from/to: native absolute (default), normalized 0–1, or percent 0–100",
          ),
        image: imageRelativeSwipeSchema
          .optional()
          .describe(
            "Screenshot-relative from/to points sharing one image source; mutually exclusive with outer from, to, and coordinateSpace. Without image, from and to are required.",
          ),
        speed: z.enum(["slow", "normal", "fast"]).optional().describe("Swipe speed preset"),
        durationMs: z
          .number()
          .int()
          .min(SWIPE_DURATION_MIN_MS)
          .max(SWIPE_DURATION_MAX_MS)
          .optional()
          .describe(
            `Exact stroke duration in ms (integer ${SWIPE_DURATION_MIN_MS}-${SWIPE_DURATION_MAX_MS}); exclusive with speed. Velocity = swipe distance / duration; the result reports the dispatched duration and velocityPxPerSecond. Android may quantize very short strokes.`,
          ),
        display: z
          .string()
          .optional()
          .describe(
            "Target panel key, role, or active; from/to/image resolve against that panel's observed screenSize (Android only)",
          ),
        layer: hierarchyLayerSchema.optional(),
        pointer: pointerSchema.optional(),
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ).superRefine((value, context) => {
    const durationError = validateDurationMs(value);
    if (durationError) {
      context.addIssue({ code: "custom", message: durationError, path: ["durationMs"] });
    }
    if (value.image !== undefined) {
      if (
        value.from !== undefined ||
        value.to !== undefined ||
        value.coordinateSpace !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "image is mutually exclusive with from, to, and coordinateSpace",
          path: ["image"],
        });
      }
      return;
    }
    for (const endpoint of ["from", "to"] as const) {
      if (value[endpoint] === undefined) {
        context.addIssue({
          code: "custom",
          message: `${endpoint} is required without image`,
          path: [endpoint],
        });
      }
    }
    validateSwipeAtRange(value, context);
  }),
  (js) => {
    js.description =
      "Swipe from one screen point to another, including diagonals. Bare from/to use platform-native observe coordinates; image uses explicit normalized fractions (preferred) or real raster pixels from a screenshot or observe.crop.";
  },
);

export type SwipeAtElementLike = Pick<SwipeAtCoordinate, "execute">;

export interface SwipeAtHandlerDependencies {
  swipeAtFactory?: (device: BootedDevice) => SwipeAtElementLike;
}

export function createSwipeAtHandler({
  swipeAtFactory = (device) => new SwipeAtCoordinate(device),
}: SwipeAtHandlerDependencies = {}) {
  return async (
    device: BootedDevice,
    args: SwipeAtArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    RecompositionTracker.getInstance().recordInteraction(device.deviceId);
    const result = await swipeAtFactory(device).execute(
      {
        ...(args.image !== undefined
          ? { image: args.image }
          : { from: args.from, to: args.to, coordinateSpace: args.coordinateSpace }),
        snapshotId: args.snapshotId,
        speed: args.speed,
        durationMs: args.durationMs,
        layer: args.layer,
        display: args.display,
        pointer: args.pointer,
      } as SwipeAtOptions,
      { progress, signal, recordingContext: getToolSelectionContext()?.toolCallRecording?.swipeAt },
    );
    const message = result.success
      ? `Swiped from (${result.x1}, ${result.y1}) to (${result.x2}, ${result.y2})`
      : `Failed to swipe from (${result.x1}, ${result.y1}) to (${result.x2}, ${result.y2}): ${result.error || "unknown error"}`;
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
  };
}

export const swipeAtHandler = createSwipeAtHandler();

export function registerSwipeAtTools() {
  ToolRegistry.registerDeviceAware(
    "swipeAt",
    "Swipe from one screen point to another, including diagonals, in native, normalized, or percent units.",
    swipeAtSchema,
    {
      handler: swipeAtHandler,
      defaultEnabled: false,
      supportsProgress: true,
      ...ANSWERS_SYSTEM_ALERTS,
      outputSchema: swipeAtResultSchema,
      ...PLAN_SKELETON,
    },
  );
}
