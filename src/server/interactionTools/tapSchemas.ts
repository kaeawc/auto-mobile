import { z } from "zod/v4";
import {
  LONG_PRESS_DEFAULT_MS,
  LONG_PRESS_HARD_MAX_MS,
  LONG_PRESS_MAX_MS,
  LONG_PRESS_MIN_MS,
} from "../../features/action/tapAtGesture";
import {
  hierarchyLayerSchema,
  nestedElementContainerSchema,
  resolverSelectionStrategySchema,
  tapOnSelectorSchema,
} from "../../models/elementSelectorSchemas";
import {
  addDeviceTargetingToSchema,
  compactExclusiveSelectorProperties,
  platformSchema,
  responseShapeControlFields,
  withJsonSchemaOverride,
} from "../../utils/schemaHelpers";
import { coordinatePointInputSchema, validateCoordinateRange } from "../coordinateRangeValidation";
import { imageRelativePointSchema } from "../imageRelativePointSchema";
import type { TapOnArgs } from "../interactionToolTypes";
import { pointerSchema } from "../pointerSchema";

function validateLongPressDuration(
  action: string | undefined,
  duration: number,
  ctx: z.RefinementCtx,
): void {
  if (action === undefined && duration > 0 && duration < LONG_PRESS_MIN_MS) {
    ctx.addIssue({
      code: "custom",
      message: `longPress duration must be 0 (platform default) or at least ${LONG_PRESS_MIN_MS} ms`,
      path: ["duration"],
    });
  }
}

function validateTapOnSelectionSchema(
  value: Pick<TapOnArgs, "ensureChecked" | "action" | "selectionStrategy" | "sibling" | "selector">,
  ctx: z.RefinementCtx,
): void {
  if (value.ensureChecked !== undefined && (value.action ?? "tap") !== "tap") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'ensureChecked requires action "tap"',
      path: ["ensureChecked"],
    });
  }
  if (value.ensureChecked !== undefined && value.selectionStrategy === "random") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "ensureChecked cannot use random selection; use a unique selector or index",
      path: ["ensureChecked"],
    });
  }
  if (
    value.selectionStrategy === "unique" &&
    (value.sibling || "accessibilityLink" in value.selector)
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "unique selection cannot use sibling or direct accessibilityLink; select a unique owner with subtext instead",
      path: ["selectionStrategy"],
    });
  }
}

export const tapOnSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        selector: tapOnSelectorSchema,
        display: z.string().optional().describe("Target panel key, role, or active"),
        layer: hierarchyLayerSchema.optional(),
        sibling: z
          .boolean()
          .optional()
          .describe("Tap a clickable sibling of the match, e.g. checkbox beside label"),
        container: nestedElementContainerSchema
          .optional()
          .describe(
            "Nested container scope; outermost resolves first, each level searches strict descendants. Per-level index is zero-based.",
          ),
        action: z
          .enum(["tap", "doubleTap", "longPress", "focus"])
          .optional()
          .describe("Action type (default: longPress with positive duration, otherwise tap)"),
        selectionStrategy: resolverSelectionStrategySchema
          .optional()
          .describe(
            "Selection strategy: first (default), random, or unique. Unique requires exactly one match at every unindexed scope and target.",
          ),
        index: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "0-based index into the full candidate list, ranked by topmost window, then " +
              "smallest eligible area. Index 0 is the default first pick when candidates share " +
              "an action. Out of range → no match.",
          ),
        // A negative duration used to be accepted and silently degraded a
        // longPress into a plain tap (#5769); bound it like the sibling params.
        duration: z
          .number()
          .min(0, "must be >= 0")
          .max(LONG_PRESS_HARD_MAX_MS, `longPress duration must be <= ${LONG_PRESS_HARD_MAX_MS} ms`)
          .optional()
          .describe(
            `Long press duration (ms; maximum ${LONG_PRESS_HARD_MAX_MS}; must fit the remaining request budget including 2000 ms dispatch headroom). Positive duration without action means longPress; positive duration with action tap is refused. For longPress, 0 or omitted uses the platform default.`,
          ),
        subtext: z
          .object({
            text: z
              .string()
              .trim()
              .min(1)
              .describe("Exact visible text of a semantic link inside the selected element"),
            occurrence: z
              .number()
              .int()
              .nonnegative()
              .optional()
              .describe("Zero-based occurrence among exact semantic-link matches (default: 0)"),
          })
          .strict()
          .optional()
          .describe(
            "Semantic link inside the selected element; fails if the platform does not expose that link",
          ),
        searchUntil: z
          .object({
            duration: z
              .number()
              .min(100)
              .max(12000)
              .optional()
              .describe("Polling duration (ms, default: 1500)"),
          })
          .optional()
          .describe("Poll for element before tapping"),
        preTapStability: z
          .boolean()
          .optional()
          .describe("Require stable bounds before tapping; use for dynamic UI"),
        retryIfNoChange: z
          .boolean()
          .optional()
          .describe("Retry once if the view hierarchy is unchanged after tap"),
        ensureTap: z.boolean().optional().describe("Enable preTapStability and retryIfNoChange"),
        ensureChecked: z
          .boolean()
          .optional()
          .describe(
            'Skip tapping if the resolved toggle element\'s checked state already matches this value; otherwise tap and verify it flipped. Requires the element to have the toggle affordance and action "tap".',
          ),
        // #5870: a `sessionUuid` resolves the platform, so `platform` is not
        // required — a device handle from getAndroid is sufficient on its own.
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ).superRefine((value, ctx) => {
    const { duration = 0 } = value;
    const action = value.action ?? (duration > 0 ? "longPress" : "tap");
    validateLongPressDuration(value.action, duration, ctx);
    validateTapOnSelectionSchema({ ...value, action }, ctx);
    const isDirectLink = "accessibilityLink" in value.selector;
    const addIssue = (invalid: unknown, message: string, path: (string | number)[]) => {
      if (!invalid) {
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        path,
      });
    };
    if (!isDirectLink && !value.subtext) {
      return;
    }
    addIssue(
      isDirectLink && value.subtext,
      "accessibilityLink and subtext cannot be used together",
      ["subtext"],
    );
    addIssue(action !== "tap", "semantic link activation supports only the tap action", ["action"]);
    addIssue(value.sibling, "semantic link activation cannot use sibling", ["sibling"]);
    addIssue(
      value.retryIfNoChange || value.ensureTap,
      "semantic link activation cannot retry an acknowledged link activation",
      value.retryIfNoChange
        ? ["retryIfNoChange"]
        : value.ensureTap
          ? ["ensureTap"]
          : ["ensureChecked"],
    );
    addIssue(
      value.ensureChecked !== undefined,
      "semantic link activation cannot ensure checked state",
      ["ensureChecked"],
    );
    addIssue(value.searchUntil, "semantic link activation cannot use searchUntil", ["searchUntil"]);
    addIssue(value.layer !== undefined, "semantic link activation cannot use layer", ["layer"]);
    addIssue(
      value.subtext && value.index !== undefined,
      "owner-scoped semantic link activation cannot use index; use a unique owner selector",
      ["index"],
    );
    addIssue(
      value.subtext && value.selectionStrategy === "random",
      "owner-scoped semantic link activation cannot use random selection; use a unique owner selector",
      ["selectionStrategy"],
    );
  }),
  (js) => {
    compactExclusiveSelectorProperties(js, ["selector", "container"]);
  },
);

export const tapAtSchema = withJsonSchemaOverride(
  coordinatePointInputSchema()
    .extend({
      includeExtras: responseShapeControlFields.includeExtras,
      x: coordinatePointInputSchema().shape.x.optional(),
      y: coordinatePointInputSchema().shape.y.optional(),
      image: imageRelativePointSchema
        .optional()
        .describe(
          "Screenshot-relative point; mutually exclusive with outer x, y, and coordinateSpace. Without image, x and y are required.",
        ),
      action: z
        .enum(["tap", "longPress", "doubleTap"])
        .optional()
        .describe("Coordinate gesture (default: tap)"),
      layer: hierarchyLayerSchema.optional(),
      durationMs: z
        .number()
        .int()
        .min(LONG_PRESS_MIN_MS)
        .max(LONG_PRESS_MAX_MS)
        .optional()
        .describe(
          `Long-press duration in milliseconds (${LONG_PRESS_MIN_MS}–${LONG_PRESS_MAX_MS}; default ${LONG_PRESS_DEFAULT_MS}); only with longPress`,
        ),
      pointer: pointerSchema.optional(),
    })
    .superRefine((value, context) => {
      if (value.durationMs !== undefined && value.action !== "longPress") {
        context.addIssue({
          code: "custom",
          message: "durationMs is only valid with action longPress",
          path: ["durationMs"],
        });
      }
      if (value.image !== undefined) {
        if (value.x !== undefined || value.y !== undefined || value.coordinateSpace !== undefined) {
          context.addIssue({
            code: "custom",
            message: "image is mutually exclusive with x, y, and coordinateSpace",
            path: ["image"],
          });
        }
      } else {
        for (const axis of ["x", "y"] as const) {
          if (value[axis] === undefined) {
            context.addIssue({
              code: "custom",
              message: `${axis} is required without image`,
              path: [axis],
            });
          }
        }
        validateCoordinateRange(value, context);
      }
    }),
  (js) => {
    js.description =
      "Tap, long press, or double tap a screen point. Bare x/y use platform-native observe coordinates; image uses explicit normalized fractions (preferred) or real raster pixels from a screenshot or observe.crop.";
  },
);

/** The preview retains the bare coordinate target without dispatching input. */
export const hitTestSchema = withJsonSchemaOverride(
  coordinatePointInputSchema()
    .omit({ raw: true, project: true })
    .superRefine(validateCoordinateRange),
  (js) => {
    js.description =
      "Preview which hierarchy nodes sit beneath one absolute point without dispatching input.";
  },
);

export const tapAnySchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        display: z.string().optional().describe("Target panel key, role, or active"),
        container: nestedElementContainerSchema
          .optional()
          .describe(
            "Nested container scope; outermost resolves first, each level searches strict descendants. Per-level index is zero-based.",
          ),
        selectionStrategy: resolverSelectionStrategySchema
          .optional()
          .describe(
            "Element selection strategy: first (default), random, or unique; unique requires exactly one eligible target and every unindexed container",
          ),
        scrollableContainer: z
          .boolean()
          .optional()
          .describe("Search only scrollable containers/lists"),
        layer: hierarchyLayerSchema.optional(),
        action: z
          .enum(["tap", "doubleTap", "longPress"])
          .optional()
          .describe("Action type (default: longPress when duration is given, otherwise tap)"),
        // Bounded like tapOn.duration so a negative longPress cannot silently
        // become a plain tap (#5769).
        duration: z
          .number()
          .min(0, "must be >= 0")
          .max(LONG_PRESS_HARD_MAX_MS, `longPress duration must be <= ${LONG_PRESS_HARD_MAX_MS} ms`)
          .optional()
          .describe(
            `Long press duration (ms; maximum ${LONG_PRESS_HARD_MAX_MS}; must fit the remaining request budget including 2000 ms dispatch headroom; 0 or omitted uses the platform default)`,
          ),
        searchUntil: z
          .object({
            duration: z
              .number()
              .min(100)
              .max(12000)
              .optional()
              .describe("Polling duration (ms, default: 1500)"),
          })
          .optional()
          .describe("Poll for clickable element before tapping"),
        // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
        // not required — a device handle from getAndroid/getApple is sufficient on
        // its own.
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  )
    .superRefine((value, context) => {
      validateLongPressDuration(value.action, value.duration ?? 0, context);
      if (
        value.duration !== undefined &&
        value.action !== undefined &&
        value.action !== "longPress"
      ) {
        context.addIssue({
          code: "custom",
          message: "duration is only valid with action longPress",
          path: ["duration"],
        });
      }
    })
    .overwrite((value) => ({
      ...value,
      action: value.action ?? (value.duration !== undefined ? "longPress" : "tap"),
    })),
  (js) => compactExclusiveSelectorProperties(js, ["container"]),
);
