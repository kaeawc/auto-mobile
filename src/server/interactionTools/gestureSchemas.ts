import { z } from "zod/v4";
import {
  DRAG_DURATION_MAX_MS,
  DRAG_DURATION_MIN_MS,
  HOLD_DURATION_MAX_MS,
  HOLD_DURATION_MIN_MS,
  PRESS_DURATION_MAX_MS,
  PRESS_DURATION_MIN_MS,
} from "../../features/action/DragAndDrop";
import {
  PINCH_DISTANCE_EXCLUSIVE_MIN,
  PINCH_DURATION_MAX_MS,
  PINCH_DURATION_MIN_MS,
  PINCH_ROTATION_MAX_DEGREES,
  PINCH_ROTATION_MIN_DEGREES,
  PINCH_SCALE_EXCLUSIVE_MIN,
} from "../../features/action/PinchOn";
import {
  EDGE_AT_DEFAULT,
  EDGE_INSET_DEFAULT,
  EDGE_INSET_MAX,
  validateEdgeSwipeOptions,
} from "../../features/action/swipeon/edgeSwipe";
import { resolveSwipeDirection } from "../../features/action/swipeon/swipeOnUtils";
import {
  SWIPE_APEX_PAUSE_MAX_MS,
  SWIPE_APEX_PAUSE_MIN_MS,
  SWIPE_BOOMERANG_MAX_MS,
  SWIPE_DURATION_MAX_MS,
  SWIPE_DURATION_MIN_MS,
  SWIPE_RETURN_DURATION_MAX_MS,
  SWIPE_RETURN_SPEED_EXCLUSIVE_MIN,
  SWIPE_RETURN_SPEED_MAX,
  validateSwipeTimingOptions,
} from "../../features/action/swipeon/swipeTiming";
import {
  createElementIdTextSelectorSchema,
  hierarchyLayerSchema,
  nestedElementContainerSchema,
  resolverSelectionStrategySchema,
} from "../../models/elementSelectorSchemas";
import {
  addDeviceTargetingToSchema,
  compactExclusiveSelectorProperties,
  platformSchema,
  responseShapeControlFields,
  withJsonSchemaOverride,
} from "../../utils/schemaHelpers";

const dragAndDropSelectorSchema = (label: "Source" | "Target") => {
  const selector = createElementIdTextSelectorSchema({
    elementId: `${label} ID`,
    text: `${label} text`,
  });
  const scope = {
    container: nestedElementContainerSchema
      .optional()
      .describe("Nested container scope for this endpoint; outermost container resolves first"),
    selectionStrategy: resolverSelectionStrategySchema
      .optional()
      .describe(
        "Endpoint selection strategy (default: first); unique requires one match at every unindexed scope level and at the target",
      ),
  };
  return z
    .union([selector.options[0].extend(scope), selector.options[1].extend(scope)])
    .describe(`${label} element`);
};

const swipeOnLookForSelector = createElementIdTextSelectorSchema({
  elementId: "ID of the element to look for",
  text: "Text to look for",
});

const swipeOnLookForScope = {
  container: nestedElementContainerSchema
    .optional()
    .describe(
      "Additional nested scope within the swipe container; re-resolved on every observation",
    ),
  selectionStrategy: resolverSelectionStrategySchema
    .optional()
    .describe(
      "Target selection strategy (default: first); unique requires one target and every unindexed scope",
    ),
};

const swipeOnLookForSchema = z.union([
  swipeOnLookForSelector.options[0].extend(swipeOnLookForScope),
  swipeOnLookForSelector.options[1].extend(swipeOnLookForScope),
]);

// #6613: dragAndDrop/swipeOn/pinchOn advertised
// `additionalProperties: false` but were not `.strict()`, so an undeclared
// caller argument was silently dropped instead of rejected. Same treatment as
// tapOn/tapAny (#6154).
export const dragAndDropSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        display: z.string().optional().describe("Target panel key, role, or active"),
        source: dragAndDropSelectorSchema("Source"),
        target: dragAndDropSelectorSchema("Target"),
        layer: hierarchyLayerSchema.optional(),
        pressDurationMs: z
          .number()
          .min(PRESS_DURATION_MIN_MS)
          .max(PRESS_DURATION_MAX_MS)
          .optional()
          .describe(
            `Press duration ms (min: ${PRESS_DURATION_MIN_MS}, max: ${PRESS_DURATION_MAX_MS}, default: 600)`,
          ),
        dragDurationMs: z
          .number()
          .min(DRAG_DURATION_MIN_MS)
          .max(DRAG_DURATION_MAX_MS)
          .optional()
          .describe(
            `Drag duration ms (min: ${DRAG_DURATION_MIN_MS}, max: ${DRAG_DURATION_MAX_MS}, default: 300)`,
          ),
        holdDurationMs: z
          .number()
          .min(HOLD_DURATION_MIN_MS)
          .max(HOLD_DURATION_MAX_MS)
          .optional()
          .describe(
            `Hold duration ms (min: ${HOLD_DURATION_MIN_MS}, max: ${HOLD_DURATION_MAX_MS}, default: 100)`,
          ),
        // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
        // not required — a device handle from getAndroid/getApple is sufficient on
        // its own.
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ),
  (js) => compactExclusiveSelectorProperties(js, ["source", "target"]),
);

function swipeTimingErrorPath(error: string): string {
  if (error.startsWith("durationMs")) {
    return "durationMs";
  }
  return error.startsWith("apexPause") ? "apexPause" : "returnSpeed";
}

export const swipeOnSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        display: z.string().optional().describe("Target panel key, role, or active"),
        includeSystemInsets: z
          .boolean()
          .optional()
          .describe(
            "Use full screen including status/nav bars; with display, requires the selected Android panel's own available insets",
          ),
        container: nestedElementContainerSchema
          .optional()
          .describe(
            "Nested swipe container scope; outermost resolves first, with per-level index and selectionStrategy",
          ),
        autoTarget: z
          .boolean()
          .optional()
          .describe(
            "Auto-target scrollable containers (default: true; with Android display, opt-in)",
          ),
        direction: z.enum(["up", "down", "left", "right"]).describe("Swipe/scroll direction"),
        gestureType: z
          .enum(["swipeFingerTowardsDirection", "scrollTowardsDirection"])
          .optional()
          .describe(
            "Finger direction or content scroll direction; default: swipeFingerTowardsDirection",
          ),
        lookFor: swipeOnLookForSchema
          .optional()
          .describe(
            "Element to find by scrolling; with display, observes and swipes only the selected Android panel",
          ),
        boomerang: z.boolean().optional().describe("Return to start position after swipe apex"),
        apexPause: z
          .number()
          .finite()
          .min(SWIPE_APEX_PAUSE_MIN_MS)
          .max(SWIPE_APEX_PAUSE_MAX_MS)
          .optional()
          .describe(
            `Pause duration at swipe apex in ms (${SWIPE_APEX_PAUSE_MIN_MS}-${SWIPE_APEX_PAUSE_MAX_MS}; default: 100)`,
          ),
        returnSpeed: z
          .number()
          .finite()
          .gt(SWIPE_RETURN_SPEED_EXCLUSIVE_MIN)
          .max(SWIPE_RETURN_SPEED_MAX)
          .optional()
          .describe(
            `Speed multiplier for return swipe (> ${SWIPE_RETURN_SPEED_EXCLUSIVE_MIN}, <= ${SWIPE_RETURN_SPEED_MAX}; default: 1); return duration <= ${SWIPE_RETURN_DURATION_MAX_MS} ms and total boomerang <= ${SWIPE_BOOMERANG_MAX_MS} ms`,
          ),
        speed: z.enum(["slow", "normal", "fast"]).optional().describe("Swipe speed preset"),
        durationMs: z
          .number()
          .int()
          .min(SWIPE_DURATION_MIN_MS)
          .max(SWIPE_DURATION_MAX_MS)
          .optional()
          .describe(
            `Forward-stroke duration in ms (integer ${SWIPE_DURATION_MIN_MS}-${SWIPE_DURATION_MAX_MS}); exclusive with speed and lookFor. Velocity = swipe distance / duration; the result reports the dispatched duration (boomerang: total) and, for a single swipe, velocityPxPerSecond (omitted for boomerang, lookFor, and the TalkBack route that ignores duration; uses effectiveDurationMs when clamped). Android may quantize very short strokes. Limits: the TalkBack semantic-scroll route has no timed stroke and ignores it (durationIgnored + warnings); the iOS XCUICoordinate route clamps velocity to 100-10000 pt/s (effectiveDurationMs + warnings).`,
          ),
        fromEdge: z
          .enum(["left", "right", "top", "bottom"])
          .optional()
          .describe(
            "Start at this screen (or display panel) edge and swipe inward; direction must point inward (left->right, right->left, top->down, bottom->up). Exclusive with container, lookFor, autoTarget=true. By default the start point is inset from the edge by the system bars/gesture insets (Android left/right: gesture inset plus edgeInset, e.g. x=88 for 78px + edgeInset 10), so the swipe stays in the app; pass includeSystemInsets:true to start at the physical screen edge (edgeInset px in), where a very-near-edge swipe may be taken as system back/home",
          ),
        edgeInset: z
          .number()
          .int()
          .min(0)
          .max(EDGE_INSET_MAX)
          .optional()
          .describe(
            `With fromEdge: how far inside the edge the touch starts, px (iOS points); default ${EDGE_INSET_DEFAULT} (iOS swipe-back needs the first ~20 pt). Measured from the content edge (after system insets) unless includeSystemInsets:true`,
          ),
        at: z
          .number()
          .finite()
          .min(0)
          .max(1)
          .optional()
          .describe(
            `With fromEdge: normalized 0-1 position along the edge (default ${EDGE_AT_DEFAULT})`,
          ),
        layer: hierarchyLayerSchema.optional(),
        // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
        // not required — a device handle from getAndroid/getApple is sufficient on
        // its own.
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ).superRefine((options, context) => {
    const error = validateSwipeTimingOptions(options);
    if (error) {
      context.addIssue({
        code: "custom",
        message: error,
        path: [swipeTimingErrorPath(error)],
      });
    }
    const edgeError = validateEdgeSwipeOptions({
      ...options,
      direction: resolveSwipeDirection(options).direction ?? options.direction,
    });
    if (edgeError) {
      context.addIssue({ code: "custom", message: edgeError, path: ["fromEdge"] });
    }
  }),
  (js) => compactExclusiveSelectorProperties(js, ["container", "lookFor"]),
);

export const pinchOnSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        display: z.string().optional().describe("Target panel key, role, or active"),
        direction: z
          .enum(["in", "out"])
          .describe(
            "Pinch direction; ignored when the finger distance does not change (rotation only)",
          ),
        distanceStart: z
          .number()
          .gt(PINCH_DISTANCE_EXCLUSIVE_MIN)
          .optional()
          .describe(
            `Initial finger distance (> ${PINCH_DISTANCE_EXCLUSIVE_MIN}) defaults to 60% of the target's smaller dimension for direction 'in' and 20% for 'out'; clamped to 10%-90% with a 10 px floor capped by the 90% ceiling (below 10 px for targets under 11.1 px).`,
          ),
        distanceEnd: z
          .number()
          .gt(PINCH_DISTANCE_EXCLUSIVE_MIN)
          .optional()
          .describe(
            `Final finger distance (> ${PINCH_DISTANCE_EXCLUSIVE_MIN}) defaults to 20% of the target's smaller dimension for direction 'in' and 60% for 'out'; clamped to 10%-90% with a 10 px floor capped by the 90% ceiling (below 10 px for targets under 11.1 px).`,
          ),
        scale: z
          .number()
          .gt(PINCH_SCALE_EXCLUSIVE_MIN)
          .optional()
          .describe(`Scale factor (> ${PINCH_SCALE_EXCLUSIVE_MIN}; overrides distances)`),
        duration: z
          .number()
          .int()
          .min(PINCH_DURATION_MIN_MS)
          .max(PINCH_DURATION_MAX_MS)
          .optional()
          .describe(
            `Gesture duration (integer ${PINCH_DURATION_MIN_MS}-${PINCH_DURATION_MAX_MS} ms, default: 300)`,
          ),
        rotationDegrees: z
          .number()
          .min(PINCH_ROTATION_MIN_DEGREES)
          .max(PINCH_ROTATION_MAX_DEGREES)
          .optional()
          .describe(
            `Degrees (${PINCH_ROTATION_MIN_DEGREES} to ${PINCH_ROTATION_MAX_DEGREES}) the two-finger axis rotates during the pinch (default: 0). The axis starts horizontal and ends rotated by this amount — a combined pinch+rotate, not a pinch along a fixed rotated axis. Same convention on Android and iOS. To rotate without zooming set scale: 1 (or equal distanceStart and distanceEnd); direction is then ignored.`,
          ),
        includeSystemInsets: z
          .boolean()
          .optional()
          .describe("Use full screen including status/nav bars"),
        container: nestedElementContainerSchema
          .optional()
          .describe(
            "Nested container scope; selectionStrategy (first/random/unique) is supported only inside each container level, not at the top level",
          ),
        autoTarget: z.boolean().optional().describe("Auto-target pinchable containers"),
        layer: hierarchyLayerSchema.optional(),
        // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
        // not required — a device handle from getAndroid/getApple is sufficient on
        // its own.
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ),
  (js) => compactExclusiveSelectorProperties(js, ["container"]),
);
