/**
 * The observe `waitFor` / `settled` zod schemas, their advertised compact JSON schema and the
 * cross-field refinements shared by `observe` and `openLink` (moved out of observeTools.ts, #11828).
 */
import { MAX_WAIT_FOR_TIMEOUT_MS } from "../features/observe/waitForTimeout";
import { errorMessage } from "../utils/describeUnknownError";
import { z } from "zod/v4";
import { ActionableError } from "../models/ActionableError";
import { JsonSchemaOverride } from "./toolSchemaHelpers";
import {
  nestedElementContainerSchema,
  resolverSelectionStrategySchema,
} from "./elementSelectorSchemas";
import type { HierarchyLayer } from "../models/HierarchyLayer";
import { logger } from "../utils/logger";
import { hasElementPredicate } from "./observeWaitEvaluation";

// Schema definitions
// waitFor accepts legacy selectors plus richer predicates. Element predicates are
// evaluated against the same node unless matchType is explicitly "any".
const waitForContainerField = nestedElementContainerSchema
  .optional()
  .describe(
    "Nested container scope; outermost resolves first, with per-level index and selectionStrategy",
  );

const publicActiveWindowAppIdAliases = ["packageName", "bundleId"] as const;

const appIdAliasShape = {
  packageName: z.string().optional(),
  bundleId: z.string().optional(),
};

const appIdPresenceBranches = [
  z.object({ appId: z.string() }).passthrough(),
  ...publicActiveWindowAppIdAliases.map((alias) => z.object({ [alias]: z.string() }).passthrough()),
];

const activeWindowWaitForBaseSchema = z
  .object({
    appId: z.string().optional().describe("Foreground app bundle ID / package name"),
    ...appIdAliasShape,
    activityName: z.string().optional().describe("Foreground Android activity name"),
  })
  .strict();

const activeWindowWaitForSchema = activeWindowWaitForBaseSchema.and(
  z.union([...appIdPresenceBranches, z.object({ activityName: z.string() }).passthrough()]),
);

// Absence / negation predicate (issue #3490 §4). Same element-matching fields as
// a positive predicate; the wait resolves only when NO element matches these.
const absentPredicateBaseSchema = z
  .object({
    selectionStrategy: resolverSelectionStrategySchema.optional(),
    elementId: z
      .string()
      .optional()
      .describe("Resource ID / accessibility identifier that must be absent"),
    text: z.string().optional().describe("Element text that must be absent (contains match)"),
    className: z.string().optional().describe("Element class name that must be absent"),
    contentDescription: z
      .string()
      .optional()
      .describe("Content description / accessibility label that must be absent"),
  })
  .strict();

const absentPredicatePresenceSchema = z.union([
  z.object({ elementId: z.string() }).passthrough(),
  z.object({ text: z.string() }).passthrough(),
  z.object({ className: z.string() }).passthrough(),
  z.object({ contentDescription: z.string() }).passthrough(),
]);

const absentPredicateSchema = absentPredicateBaseSchema.and(absentPredicatePresenceSchema);

const POSTURE_WAIT_DESCRIPTION =
  "Wait for the observed device posture. Single-panel inventory fails immediately; multi-panel or unavailable inventory keeps polling. Timeout diagnostics distinguish unobservable posture (no hierarchy captured), unavailable inventory, and the last observed posture.";

const waitForCommonShape = {
  posture: z
    .enum(["closed", "half_opened", "opened", "rear_display", "flipped", "tent"])
    .optional()
    .describe(POSTURE_WAIT_DESCRIPTION),
  activeDisplay: z.string().min(1).optional().describe("Wait for a panel key or role"),
  activeWindow: activeWindowWaitForSchema.optional().describe("Foreground app/window predicates"),
  absent: absentPredicateSchema
    .optional()
    .describe("Wait until an element matching these fields is absent"),
  timeout: z
    .number()
    .max(MAX_WAIT_FOR_TIMEOUT_MS, {
      message: `Wait timeout must not exceed ${MAX_WAIT_FOR_TIMEOUT_MS} ms`,
    })
    .optional()
    .describe("Wait timeout ms (default: 5000)"),
  timeoutMs: z
    .number()
    .max(MAX_WAIT_FOR_TIMEOUT_MS, {
      message: `Wait timeout must not exceed ${MAX_WAIT_FOR_TIMEOUT_MS} ms`,
    })
    .optional()
    .describe("Alias for timeout"),
  container: waitForContainerField,
  selectionStrategy: resolverSelectionStrategySchema.optional(),
};

const validateWaitForTimeoutAliases = (
  value: { timeout?: number; timeoutMs?: number },
  ctx: z.RefinementCtx,
): void => {
  if (value.timeout !== undefined && value.timeoutMs !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "waitFor accepts either timeout or timeoutMs, not both",
    });
  }
};

// Stability / "settled" gate (issue #3490 §3). After the waitFor predicate first
// matches, keep observing until the view hierarchy is unchanged for this long.
export const settledSchema = z
  .object({
    quietPeriodMs: z
      .number()
      .int()
      .positive()
      .describe("Quiet-period ms (no hierarchy change) required after waitFor matches"),
  })
  .strict();

const waitForTextAnySchema = z
  .object({
    for: z.never().optional(),
    textAny: z
      .array(z.string().min(1))
      .min(1)
      .describe("Ordered text variants; first visible match wins"),
    elementId: z.never().optional(),
    text: z.never().optional(),
    className: z.never().optional(),
    contentDescription: z.never().optional(),
    matchType: z.never().optional(),
    textMatch: z.never().optional(),
    ...waitForCommonShape,
  })
  .strict()
  .superRefine((value, ctx) => {
    validateWaitForTimeoutAliases(value, ctx);
    if (value.selectionStrategy !== undefined && value.absent === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selectionStrategy requires an element or absent predicate",
      });
    }
  });

const waitForElementBaseSchema = z
  .object({
    for: z.never().optional(),
    elementId: z.string().optional().describe("Element resource ID / accessibility identifier"),
    text: z.string().optional().describe("Element text"),
    textAny: z.never().optional(),
    className: z.string().optional().describe("Element class name"),
    contentDescription: z
      .string()
      .optional()
      .describe("Element content description / accessibility label"),
    matchType: z
      .enum(["all", "any"])
      .optional()
      .describe("Whether element predicates must all match the same node or any one may match"),
    textMatch: z
      .enum(["exact", "contains", "regex"])
      .optional()
      .describe("How to match waitFor.text; does not affect contentDescription"),
    ...waitForCommonShape,
  })
  .strict()
  .superRefine((value, ctx) => {
    validateWaitForTimeoutAliases(value, ctx);
    if (
      value.selectionStrategy !== undefined &&
      !hasElementPredicate(value) &&
      value.absent === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selectionStrategy requires an element or absent predicate",
      });
    }

    if (value.textMatch === "regex" && value.text !== undefined) {
      try {
        new RegExp(value.text);
      } catch (error) {
        // Invalid caller regexes are expected validation failures reported by the schema.
        logger.debug(`waitFor regex validation failed: ${errorMessage(error)}`);
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "text must be a valid regular expression when textMatch is regex",
        });
      }
    }
  });

const waitForPredicatePresenceSchema = z.union([
  z.object({ posture: waitForCommonShape.posture.unwrap() }).passthrough(),
  z.object({ activeDisplay: z.string().min(1) }).passthrough(),
  z.object({ elementId: z.string() }).passthrough(),
  z.object({ text: z.string() }).passthrough(),
  z.object({ className: z.string() }).passthrough(),
  z.object({ contentDescription: z.string() }).passthrough(),
  z.object({ activeWindow: activeWindowWaitForSchema }).passthrough(),
  z.object({ absent: absentPredicateSchema }).passthrough(),
]);

const waitForElementSchema = waitForElementBaseSchema.and(waitForPredicatePresenceSchema);

// Declarative predicate DSL (issue #4398): `for` selects a condition backed by a
// #4389 primitive. Everything but `stable` is a WaitForCondition predicate; the
// handler routes `stable` (whole-screen structural settle) to SettleObserve. The
// legacy-only fields are declared `never` here so the inferred union stays
// structurally compatible with the element/textAny arms (same pattern those arms
// use to exclude each other), keeping the legacy handler's field access valid.
const WAIT_FOR_CONDITION_KINDS = [
  "appear",
  "disappear",
  "clickable",
  "textEquals",
  "countStable",
] as const;
const WAIT_FOR_DSL_KINDS = [...WAIT_FOR_CONDITION_KINDS, "stable"] as const;

const waitForConditionDslSchema = z
  .object({
    for: z.enum(WAIT_FOR_DSL_KINDS).describe("Declarative condition to wait for"),
    elementId: z.string().optional().describe("Element resource ID / accessibility identifier"),
    text: z
      .string()
      .optional()
      .describe(
        "Element text; appear tries normalized exact then substring matching, while textEquals requires the exact value",
      ),
    pollMs: z.number().optional().describe("Poll interval ms (default 150)"),
    stableReads: z
      .number()
      .optional()
      .describe("Consecutive stable reads for countStable/stable (default 2)"),
    timeout: z
      .number()
      .max(MAX_WAIT_FOR_TIMEOUT_MS, {
        message: `Wait timeout must not exceed ${MAX_WAIT_FOR_TIMEOUT_MS} ms`,
      })
      .optional()
      .describe("Wait timeout ms (default 5000; stable default 2500)"),
    timeoutMs: z
      .number()
      .max(MAX_WAIT_FOR_TIMEOUT_MS, {
        message: `Wait timeout must not exceed ${MAX_WAIT_FOR_TIMEOUT_MS} ms`,
      })
      .optional()
      .describe("Alias for timeout"),
    container: waitForContainerField,
    selectionStrategy: resolverSelectionStrategySchema.optional(),
    textAny: z.never().optional(),
    className: z.never().optional(),
    contentDescription: z.never().optional(),
    matchType: z.never().optional(),
    textMatch: z.never().optional(),
    activeWindow: z.never().optional(),
    absent: z.never().optional(),
    posture: z.never().optional(),
    activeDisplay: z.never().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateWaitForTimeoutAliases(value, ctx);
    if (value.for === "stable") {
      if (value.container !== undefined || value.selectionStrategy !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'waitFor "for: stable" does not support container or selectionStrategy',
        });
      }
      return;
    }
    if (value.elementId === undefined && value.text === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `waitFor "for: ${value.for}" requires elementId or text`,
      });
    }
    if (value.for === "textEquals" && value.text === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'waitFor "for: textEquals" requires text (the exact expected value)',
      });
    }
  });

export const waitForSchema = z.union([
  waitForConditionDslSchema,
  waitForTextAnySchema,
  waitForElementSchema,
]);

// Compact advertised JSON schema for `waitFor` (issue: observe input schema
// bloat). The runtime zod `waitForSchema` above stays the source of truth for
// validation — its union/intersection/presence machinery expands to ~2k tokens
// in `tools/list`, which the agent does not need. This flat object advertises
// the same fields + guidance at ~1/4 the token cost; it is swapped in via the
// observe json-schema override below and never used for validation.
// Presence options shared by the two branches below.
const ELEMENT_PREDICATE_REQUIRED = [
  { required: ["elementId"] },
  { required: ["text"] },
  { required: ["className"] },
  { required: ["contentDescription"] },
];
const WAIT_CONTAINER_ADVERTISED_SCHEMA = z.toJSONSchema(nestedElementContainerSchema, {
  override: ({ jsonSchema }) => {
    if (jsonSchema.$ref === "#") {
      jsonSchema.$ref = "#waitForContainer";
    }
  },
});
const WAIT_SELECTION_ADVERTISED_SCHEMA = z.toJSONSchema(resolverSelectionStrategySchema);
const ABSENT_PREDICATE_ADVERTISED_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  description: "Wait until an element matching these fields is absent (text uses exact match)",
  properties: {
    selectionStrategy: WAIT_SELECTION_ADVERTISED_SCHEMA,
    elementId: { type: "string" },
    text: { type: "string" },
    className: { type: "string" },
    contentDescription: { type: "string" },
  },
  anyOf: [
    { required: ["elementId"] },
    { required: ["text"] },
    { required: ["className"] },
    { required: ["contentDescription"] },
  ],
};
const COMPACT_WAITFOR_ADVERTISED_SCHEMA: Record<string, unknown> = {
  $defs: { waitForContainer: { ...WAIT_CONTAINER_ADVERTISED_SCHEMA, $anchor: "waitForContainer" } },
  type: "object",
  additionalProperties: false,
  properties: {
    for: {
      type: "string",
      enum: ["appear", "disappear", "clickable", "textEquals", "countStable", "stable"],
    },
    pollMs: { type: "number" },
    stableReads: { type: "number" },
    elementId: { type: "string" },
    text: { type: "string" },
    textAny: {
      type: "array",
      items: { type: "string" },
    },
    className: { type: "string" },
    contentDescription: { type: "string" },
    matchType: {
      type: "string",
      enum: ["all", "any"],
    },
    textMatch: {
      type: "string",
      enum: ["exact", "contains", "regex"],
      description: "How to match waitFor.text; does not affect contentDescription",
    },
    activeWindow: {
      type: "object",
      additionalProperties: false,
      properties: {
        appId: { type: "string" },
        packageName: { type: "string" },
        bundleId: { type: "string" },
        activityName: { type: "string" },
      },
      anyOf: [
        { required: ["appId"] },
        { required: ["packageName"] },
        { required: ["bundleId"] },
        { required: ["activityName"] },
      ],
    },
    posture: {
      type: "string",
      enum: ["closed", "half_opened", "opened", "rear_display", "flipped", "tent"],
      description: POSTURE_WAIT_DESCRIPTION,
    },
    activeDisplay: { type: "string", description: "Physical panel key or role" },
    absent: ABSENT_PREDICATE_ADVERTISED_SCHEMA,
    container: { $ref: "#waitForContainer" },
    selectionStrategy: WAIT_SELECTION_ADVERTISED_SCHEMA,
    timeout: { type: "number", maximum: MAX_WAIT_FOR_TIMEOUT_MS },
    timeoutMs: { type: "number", maximum: MAX_WAIT_FOR_TIMEOUT_MS },
  },
  // Enforce the same shape the runtime does: either the `for` DSL, or at least one
  // legacy predicate with textAny mutually exclusive from the element predicates /
  // matchType / textMatch. `absent` composes with everything (including textAny),
  // so it is not part of the textAny exclusion set.
  anyOf: [
    {
      properties: { for: { const: "stable" }, container: false, selectionStrategy: false },
      required: ["for"],
    },
    {
      properties: { for: { enum: WAIT_FOR_CONDITION_KINDS } },
      required: ["for", "elementId"],
    },
    { properties: { for: { enum: WAIT_FOR_CONDITION_KINDS } }, required: ["for", "text"] },
    {
      properties: { for: false, selectionStrategy: false },
      required: ["textAny"],
    },
    {
      properties: { for: false },
      anyOf: [...ELEMENT_PREDICATE_REQUIRED, { required: ["absent"] }],
    },
    {
      properties: { for: false, selectionStrategy: false },
      anyOf: [
        ...ELEMENT_PREDICATE_REQUIRED,
        { required: ["activeWindow"] },
        { required: ["absent"] },
        { required: ["posture"] },
        { required: ["activeDisplay"] },
      ],
    },
  ],
};

// Cross-field validation shared by `observe` and `openLink` (both carry
// platform + waitFor + settled): iOS rejects Android-only activityName, and
// `settled` requires a `waitFor` predicate to settle after.
export const refineWaitForArgs = (
  value: { platform?: "android" | "ios"; waitFor?: ObserveWaitForOptions; settled?: unknown },
  ctx: z.RefinementCtx,
): void => {
  const activeWindow = value.waitFor?.activeWindow;
  if (
    value.platform === "ios" &&
    activeWindow?.activityName !== undefined &&
    activeWindow.appId === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["waitFor", "activeWindow", "activityName"],
      message: "activityName is Android-only; use appId/bundleId on iOS",
    });
  }
  if (value.settled !== undefined && value.waitFor === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["settled"],
      message: "settled requires waitFor",
    });
  }
};

/**
 * #6154 follow-up: `refineWaitForArgs`'s iOS-rejects-activityName check runs
 * at schema-parse time against the raw request `platform`, which is now
 * optional (resolved from deviceId/session). A caller that omits `platform`
 * on an iOS device would skip that check entirely at parse time, so both
 * `observe` and `openLink` re-run it here against the resolved
 * `device.platform` once ToolRegistry has determined it.
 */
export function assertActiveWindowWaitForSupportedOnPlatform(
  platform: "android" | "ios",
  waitFor: ObserveWaitForOptions | undefined,
): void {
  const activeWindow = waitFor?.activeWindow;
  if (
    platform === "ios" &&
    activeWindow?.activityName !== undefined &&
    activeWindow.appId === undefined
  ) {
    throw new ActionableError("activityName is Android-only; use appId/bundleId on iOS");
  }
}

// Shared advertised-JSON-schema override for `observe` and `openLink`: enforce
// the iOS activityName rule, require waitFor whenever settled is present, and
// swap the verbose generated `waitFor` schema for the compact advertised form.
export const overrideWaitForJsonSchema: JsonSchemaOverride = (jsonSchema) => {
  // settled has no meaning without a waitFor predicate to settle after.
  jsonSchema.dependentRequired = {
    ...(jsonSchema.dependentRequired as Record<string, string[]> | undefined),
    settled: ["waitFor"],
  };

  // Replace the verbose generated `waitFor` schema with the compact advertised
  // form. Runtime validation still uses the full zod `waitForSchema`; this only
  // shrinks what `tools/list` carries (~2064 -> ~473 tokens).
  const props = jsonSchema.properties as Record<string, unknown> | undefined;
  if (props && props.waitFor) {
    props.waitFor = COMPACT_WAITFOR_ADVERTISED_SCHEMA;
  }
};

export type ObserveWaitForOptions = z.infer<typeof waitForSchema>;
export type SettledOptions = z.infer<typeof settledSchema>;
/** waitFor options carrying the (top-level) settled gate, as threaded to {@link waitForObservation}. */
export type WaitForWithSettled = ObserveWaitForOptions & {
  settled?: SettledOptions;
  /** Scope element predicates to the app or the AutoMobile prototype (issue #9305). */
  layer?: HierarchyLayer;
};

export type WaitForConditionDsl = z.infer<typeof waitForConditionDslSchema>;
export type WaitForConditionKind = (typeof WAIT_FOR_CONDITION_KINDS)[number];
