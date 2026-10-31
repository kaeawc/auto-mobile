import { z } from "zod/v4";
import { ANSWERS_SYSTEM_ALERTS, PLAN_SKELETON } from "./toolRegistryTypes";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { MultiTouchGesture } from "../features/action/MultiTouchGesture";
import {
  MULTI_TOUCH_DEFAULT_FINGERS,
  MULTI_TOUCH_DURATION_MAX_MS,
  MULTI_TOUCH_LONG_PRESS_DEFAULT_MS,
  MULTI_TOUCH_LONG_PRESS_MIN_MS,
  MULTI_TOUCH_MAX_FINGERS,
  MULTI_TOUCH_MIN_FINGERS,
  MULTI_TOUCH_SPACING_MAX_PX,
  MULTI_TOUCH_SPACING_MIN_PX,
  MULTI_TOUCH_TAP_DURATION_MS,
  MULTI_TOUCH_SWIPE_DURATION_DEFAULT_MS,
  validateMultiTouchOptions,
} from "../features/action/multiTouchGeometry";
import { RecompositionTracker } from "../features/performance/RecompositionTracker";
import type { BootedDevice } from "../models";
import type { MultiTouchOptions } from "../models/MultiTouchOptions";
import { multiTouchResultSchema } from "./gestureToolOutputSchemas";
import { createStructuredToolResponse, type StructuredToolResponse } from "../utils/toolUtils";
import { hierarchyLayerSchema } from "../models/elementSelectorSchemas";
import {
  addDeviceTargetingToSchema,
  platformSchema,
  responseShapeControlFields,
  withJsonSchemaOverride,
} from "../utils/schemaHelpers";

export type MultiTouchArgs = MultiTouchOptions & {
  platform?: "android" | "ios";
  raw?: boolean;
  project?: "full" | "skeleton";
};

export const multiTouchSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        action: z
          .enum(["tap", "longPress", "swipe"])
          .describe("Simultaneous multi-finger gesture to perform"),
        fingers: z
          .number()
          .int()
          .min(MULTI_TOUCH_MIN_FINGERS)
          .max(MULTI_TOUCH_MAX_FINGERS)
          .optional()
          .describe(
            `Simultaneous fingers (${MULTI_TOUCH_MIN_FINGERS}-${MULTI_TOUCH_MAX_FINGERS}, default ${MULTI_TOUCH_DEFAULT_FINGERS}); use tapAt/swipeOn for one finger. Counts above 2 on Android need the multi_finger_gesture_v1 CtrlProxy capability and are refused before dispatch otherwise`,
          ),
        x: z.number().finite().describe("Finger-group center x in the selected coordinateSpace"),
        y: z.number().finite().describe("Finger-group center y in the selected coordinateSpace"),
        coordinateSpace: z
          .enum(["absolute", "normalized", "percent"])
          .optional()
          .describe("Units for x/y: native absolute (default), normalized 0-1, or percent 0-100"),
        direction: z
          .enum(["up", "down", "left", "right"])
          .optional()
          .describe("Swipe finger direction; required for swipe, invalid otherwise"),
        distance: z
          .number()
          .finite()
          .positive()
          .optional()
          .describe(
            "Swipe travel in native px (default 30% of the travel axis); clamped so every finger stays on screen",
          ),
        fingerSpacing: z
          .number()
          .finite()
          .min(MULTI_TOUCH_SPACING_MIN_PX)
          .max(MULTI_TOUCH_SPACING_MAX_PX)
          .optional()
          .describe(
            `Horizontal gap between neighbouring fingers in native px (${MULTI_TOUCH_SPACING_MIN_PX}-${MULTI_TOUCH_SPACING_MAX_PX}; default 10% of the width, 40-160). The row is centered on x and shifted to fit the screen`,
          ),
        durationMs: z
          .number()
          .int()
          .min(1)
          .max(MULTI_TOUCH_DURATION_MAX_MS)
          .optional()
          .describe(
            `Duration in ms (max ${MULTI_TOUCH_DURATION_MAX_MS}). longPress ${MULTI_TOUCH_LONG_PRESS_MIN_MS}-${MULTI_TOUCH_DURATION_MAX_MS}, default ${MULTI_TOUCH_LONG_PRESS_DEFAULT_MS}; swipe default ${MULTI_TOUCH_SWIPE_DURATION_DEFAULT_MS}; tap is fixed at ${MULTI_TOUCH_TAP_DURATION_MS}`,
          ),
        layer: hierarchyLayerSchema.optional(),
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ).superRefine((value, context) => {
    const error = validateMultiTouchOptions(value);
    if (error) {
      context.addIssue({ code: "custom", message: error, path: [issuePath(error)] });
    }
    if (value.coordinateSpace === "normalized" || value.coordinateSpace === "percent") {
      const max = value.coordinateSpace === "normalized" ? 1 : 100;
      for (const axis of ["x", "y"] as const) {
        if (value[axis] < 0 || value[axis] > max) {
          context.addIssue({
            code: "custom",
            message: `${axis} must be between 0 and ${max}`,
            path: [axis],
          });
        }
      }
    }
  }),
  (js) => {
    js.description =
      "Simultaneous 2-5 finger tap, long press, or swipe at a screen point. Fingers sit in a horizontal row centered on x/y.";
  },
);

function issuePath(error: string): string {
  const field = ["fingers", "direction", "distance", "fingerSpacing", "durationMs"].find((name) =>
    error.startsWith(name),
  );
  return field ?? "action";
}

export type MultiTouchGestureLike = Pick<MultiTouchGesture, "execute">;

export interface MultiTouchHandlerDependencies {
  multiTouchFactory?: (device: BootedDevice) => MultiTouchGestureLike;
}

const VERBS = { tap: "Tapped", longPress: "Long pressed", swipe: "Swiped" } as const;

export function createMultiTouchHandler({
  multiTouchFactory = (device) => new MultiTouchGesture(device),
}: MultiTouchHandlerDependencies = {}) {
  return async (
    device: BootedDevice,
    args: MultiTouchArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    RecompositionTracker.getInstance().recordInteraction(device.deviceId);
    const result = await multiTouchFactory(device).execute(
      {
        action: args.action,
        fingers: args.fingers,
        x: args.x,
        y: args.y,
        coordinateSpace: args.coordinateSpace,
        direction: args.direction,
        distance: args.distance,
        fingerSpacing: args.fingerSpacing,
        durationMs: args.durationMs,
        layer: args.layer,
      },
      { progress, signal },
    );
    const message = result.success
      ? `${VERBS[args.action]} with ${result.fingers} fingers at (${result.x1}, ${result.y1})`
      : `Failed to ${args.action} with ${result.fingers} fingers at (${result.x1}, ${result.y1}): ${result.error || "unknown error"}`;
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

export const multiTouchHandler = createMultiTouchHandler();

export function registerMultiTouchTools() {
  ToolRegistry.registerDeviceAware(
    "multiTouch",
    "Simultaneous 2-5 finger tap, long press, or swipe at a screen point.",
    multiTouchSchema,
    {
      handler: multiTouchHandler,
      defaultEnabled: false,
      supportsProgress: true,
      ...ANSWERS_SYSTEM_ALERTS,
      outputSchema: multiTouchResultSchema,
      ...PLAN_SKELETON,
    },
  );
}
