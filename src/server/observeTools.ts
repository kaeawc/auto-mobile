import { errorMessage } from "../utils/describeUnknownError";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ResourceRegistry } from "./resourceRegistry";
import { RESOURCE_URIS } from "./observationResources";
import { OBSERVE_APP_RESOURCE_URI } from "./observeAppResource";
import { ActionableError } from "../models/ActionableError";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import type { ObserveScreen } from "../features/observe/interfaces/ObserveScreen";
import { RealSettleObserve } from "../features/observe/SettleObserve";
import { RealWaitForCondition } from "../features/observe/WaitForCondition";
import type { ConditionPredicate } from "../features/observe/interfaces/WaitForCondition";
import {
  appear,
  disappear,
  clickable,
  textEquals,
  countStable,
  ConditionSelector,
} from "../features/observe/ConditionPredicates";
import {
  createJSONToolResponse,
  createStructuredToolResponse,
  throwIfAborted,
  StructuredToolResponse,
} from "../utils/toolUtils";
import {
  BootedDevice,
  Element,
  ObserveResult,
  ObserveToolPayload,
  ViewHierarchyResult,
} from "../models";
import { createGlobalPerformanceTracker } from "../utils/PerformanceTracker";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import {
  IdentifyInteractions,
  IdentifyInteractionsOptions,
} from "../features/observe/IdentifyInteractions";
import {
  addDeviceTargetingToSchema,
  JsonSchemaOverride,
  platformSchema,
  withAppIdAliases,
  withJsonSchemaOverride,
} from "./toolSchemaHelpers";
import { elementContainerSchema } from "./elementSelectorSchemas";
import { observeToolResultSchema } from "./toolOutputSchemas";
import { DefaultElementFinder } from "../features/utility/ElementFinder";
import { DefaultElementParser } from "../features/utility/ElementParser";
import { normalizeQuotes } from "../features/utility/TextMatcher";
import type { ElementFinder } from "../utils/interfaces/ElementFinder";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { consumeSetupTiming } from "./ToolExecutionContext";
import { AndroidCtrlProxyManager } from "../utils/CtrlProxyManager";
import { logger } from "../utils/logger";
import { serverConfig } from "../utils/ServerConfig";
import { NodeCryptoService } from "../utils/crypto";
import { shouldSkipObserveWaitForScreenshot } from "../features/observe/automaticScreenshotPolicy";

// Schema definitions
// waitFor accepts legacy selectors plus richer predicates. Element predicates are
// evaluated against the same node unless matchType is explicitly "any".
const waitForContainerField = elementContainerSchema
  .optional()
  .describe("Scope match to a container");

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

const waitForCommonShape = {
  activeWindow: activeWindowWaitForSchema.optional().describe("Foreground app/window predicates"),
  absent: absentPredicateSchema
    .optional()
    .describe("Wait until an element matching these fields is absent"),
  timeout: z.number().optional().describe("Wait timeout ms (default: 5000)"),
  timeoutMs: z.number().optional().describe("Alias for timeout"),
  container: waitForContainerField,
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
  .superRefine(validateWaitForTimeoutAliases);

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

    if (value.textMatch === "regex" && value.text !== undefined) {
      try {
        new RegExp(value.text);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "text must be a valid regular expression when textMatch is regex",
        });
      }
    }
  });

const waitForPredicatePresenceSchema = z.union([
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
      .describe("Element text; for `textEquals` this is the exact expected value"),
    pollMs: z.number().optional().describe("Poll interval ms (default 150)"),
    stableReads: z
      .number()
      .optional()
      .describe("Consecutive stable reads for countStable/stable (default 2)"),
    timeout: z.number().optional().describe("Wait timeout ms (default 5000; stable default 2500)"),
    timeoutMs: z.number().optional().describe("Alias for timeout"),
    container: waitForContainerField,
    textAny: z.never().optional(),
    className: z.never().optional(),
    contentDescription: z.never().optional(),
    matchType: z.never().optional(),
    textMatch: z.never().optional(),
    activeWindow: z.never().optional(),
    absent: z.never().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateWaitForTimeoutAliases(value, ctx);
    if (value.for === "stable") {
      if (value.container !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'waitFor "for: stable" does not support container',
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
const ABSENT_PREDICATE_ADVERTISED_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  description: "Wait until an element matching these fields is absent (text uses contains match)",
  properties: {
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
  type: "object",
  additionalProperties: false,
  not: { required: ["timeout", "timeoutMs"] },
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
    absent: ABSENT_PREDICATE_ADVERTISED_SCHEMA,
    container: {
      type: "object",
      properties: { elementId: { type: "string" }, text: { type: "string" } },
      additionalProperties: false,
      oneOf: [{ required: ["elementId"] }, { required: ["text"] }],
    },
    timeout: { type: "number" },
    timeoutMs: { type: "number" },
  },
  // Enforce the same shape the runtime does: either the `for` DSL, or at least one
  // legacy predicate with textAny mutually exclusive from the element predicates /
  // matchType / textMatch. `absent` composes with everything (including textAny),
  // so it is not part of the textAny exclusion set.
  anyOf: [
    {
      properties: { for: { const: "stable" } },
      required: ["for"],
      not: { required: ["container"] },
    },
    {
      properties: { for: { not: { enum: ["stable", "textEquals"] } } },
      required: ["for", "elementId"],
    },
    { properties: { for: { not: { const: "stable" } } }, required: ["for", "text"] },
    {
      required: ["textAny"],
      not: {
        anyOf: [
          ...ELEMENT_PREDICATE_REQUIRED,
          { required: ["matchType"] },
          { required: ["textMatch"] },
        ],
      },
    },
    {
      not: { anyOf: [{ required: ["textAny"] }, { required: ["for"] }] },
      anyOf: [
        ...ELEMENT_PREDICATE_REQUIRED,
        { required: ["activeWindow"] },
        { required: ["absent"] },
      ],
    },
  ],
};

// Progressive-disclosure scoping of the returned hierarchy (issue #4344). The
// agent picks where to zoom on THIS screen, so region/anchor are per-call inputs
// (not env). Every dimension is always honored when requested — the focus /
// region / overview scoping is on by default and applies only when a call sets
// the matching `scope` field.
const observeScopeFocusSchema = z
  .union([
    z.boolean(),
    z.object({
      resourceId: z.string().optional().describe("Anchor by exact resource-id"),
      text: z.string().optional().describe("Anchor by substring text match"),
    }),
  ])
  .describe("Scope to a subtree: true = foreground app; {resourceId|text} = anchor.");

const observeScopeRegionBoxSchema = z
  .object({
    x1: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
    x2: z.number().min(0).max(1),
    y2: z.number().min(0).max(1),
  })
  .refine((b) => b.x1 < b.x2 && b.y1 < b.y2, {
    message: "region requires x1 < x2 and y1 < y2",
  });

const observeScopeSchema = z
  .object({
    focus: observeScopeFocusSchema.optional(),
    region: z
      .union([z.boolean(), observeScopeRegionBoxSchema])
      .optional()
      .describe("Crop to a normalized 0..1 box; true = inset content rect."),
    overview: z.boolean().optional().describe("Collapse to a container skeleton."),
  })
  .describe("Experimental progressive-disclosure scoping of the returned hierarchy (issue #4344)");

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
  jsonSchema.if = {
    required: ["platform", "waitFor"],
    properties: {
      platform: { const: "ios" },
      waitFor: {
        required: ["activeWindow"],
        properties: {
          activeWindow: {
            required: ["activityName"],
            not: {
              anyOf: [
                { required: ["appId"] },
                { required: ["bundleId"] },
                { required: ["packageName"] },
              ],
            },
          },
        },
      },
    },
  };
  jsonSchema.then = false;

  // settled has no meaning without a waitFor predicate to settle after.
  jsonSchema.dependentRequired = {
    ...(jsonSchema.dependentRequired as Record<string, string[]> | undefined),
    settled: ["waitFor"],
  };

  // Replace the verbose generated `waitFor` schema with the compact advertised
  // form. Runtime validation still uses the full zod `waitForSchema`; this only
  // shrinks what `tools/list` carries (~2064 -> ~473 tokens). The `if`/`then`
  // above evaluates against the request data, not this schema, so it is
  // unaffected.
  const props = jsonSchema.properties as Record<string, unknown> | undefined;
  if (props && props.waitFor) {
    props.waitFor = COMPACT_WAITFOR_ADVERTISED_SCHEMA;
  }
};

const observeBaseSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z.object({
      // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
      // not required — a device handle from getAndroid/getApple is sufficient on
      // its own.
      platform: platformSchema.optional(),
      waitFor: waitForSchema
        .optional()
        .describe("Wait for element to appear before returning observation"),
      settled: settledSchema
        .optional()
        .describe("After waitFor matches, wait for a quiet hierarchy period (requires waitFor)"),
      raw: z.boolean().optional().describe("Include raw view hierarchy"),
      project: z
        .enum(["full", "skeleton"])
        .optional()
        .describe(
          "Output projection. 'skeleton' (default) returns a flat, actionable-only list " +
            "(elementId/label/bounds/affordances) in place of viewHierarchy/elements. Each skeleton " +
            "elementId/label is directly usable " +
            "as a tapOn selector; re-request with raw/project:'full' to disambiguate.",
        ),
      skipBackStack: z.boolean().optional().describe("Skip back stack during waitFor polling"),
      scope: observeScopeSchema.optional(),
    }),
  ).superRefine(refineWaitForArgs),
  overrideWaitForJsonSchema,
);

export const observeSchema = withAppIdAliases(observeBaseSchema);

export const identifyInteractionsSchema = addDeviceTargetingToSchema(
  z.object({
    // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
    // not required — a device handle from getAndroid/getApple is sufficient on
    // its own.
    platform: platformSchema.optional(),
    filter: z
      .object({
        types: z
          .array(z.enum(["navigation", "input", "action", "scroll", "toggle"]))
          .optional()
          .describe("Interaction types"),
        minConfidence: z.number().min(0).max(1).optional().describe("Min confidence (0-1)"),
        limit: z.number().int().positive().optional().describe("Max results"),
      })
      .optional()
      .describe("Filter options"),
    includeContext: z
      .object({
        navigationGraph: z.boolean().optional().describe("Include nav graph predictions"),
        elementDetails: z.boolean().optional().describe("Include element details"),
        suggestedParams: z.boolean().optional().describe("Include tool params"),
      })
      .optional()
      .describe("Context options"),
  }),
);

const WAIT_FOR_POLL_INTERVAL_MS = 100;

export type ObserveWaitForOptions = z.infer<typeof waitForSchema>;
export type SettledOptions = z.infer<typeof settledSchema>;
/** waitFor options carrying the (top-level) settled gate, as threaded to {@link waitForObservation}. */
export type WaitForWithSettled = ObserveWaitForOptions & { settled?: SettledOptions };
type ObserveArgs = z.infer<typeof observeSchema>;
type WaitForConditionDsl = z.infer<typeof waitForConditionDslSchema>;
type WaitForConditionKind = (typeof WAIT_FOR_CONDITION_KINDS)[number];

/** Metadata produced by an `observe.waitFor` poll. */
export interface WaitForObservationOutcome {
  observation: ObserveResult;
  awaitedElement?: Element;
  awaitDuration: number;
  awaitTimeout: boolean;
  matched?: boolean;
  settled?: boolean;
  timedOut: boolean;
  polls: number;
  waitMs: number;
  matchedElement?: Element;
  candidates?: Element[];
}

/** True when the waitFor options are the #4398 declarative `for` DSL form. */
const isConditionDsl = (waitFor: ObserveWaitForOptions): waitFor is WaitForConditionDsl =>
  (waitFor as { for?: unknown }).for !== undefined;

/**
 * Build the #4389 {@link ConditionPredicate} for a DSL `for` kind (issue #4398).
 * `stable` is intentionally not handled here — the handler routes it to
 * `RealSettleObserve` (whole-screen settle) rather than a predicate. Throws an
 * `ActionableError` for `textEquals` without a `text` value, mirroring the zod
 * refinement so the standalone tool path fails with the same actionable message.
 */
export const buildConditionPredicate = (
  finder: ElementFinder,
  kind: WaitForConditionKind,
  selector: ConditionSelector,
  options?: { stableReads?: number },
): ConditionPredicate => {
  switch (kind) {
    case "appear":
      return appear(finder, selector);
    case "disappear":
      return disappear(finder, selector);
    case "clickable":
      return clickable(finder, selector);
    case "textEquals":
      if (selector.text === undefined) {
        throw new ActionableError(
          'waitFor "for: textEquals" requires text (the exact expected value)',
        );
      }
      return textEquals(finder, selector, selector.text);
    case "countStable":
      return countStable(finder, selector, options);
    default: {
      const exhaustive: never = kind;
      throw new ActionableError(`Unknown waitFor condition: ${String(exhaustive)}`);
    }
  }
};

/**
 * Run the declarative `for` DSL (issue #4398) and adapt its result to the shared
 * `waitForObservation` return shape. `stable` runs the settle loop
 * (`RealSettleObserve`); every other kind runs `RealWaitForCondition` with the
 * predicate for that kind. `awaitedElement` carries the matched element (never set
 * for settle / countStable, which have no single element); `awaitTimeout` reflects
 * "did not settle" / "timed out".
 */
const runWaitForConditionDsl = async (
  observeScreen: ObserveScreen,
  waitFor: WaitForConditionDsl,
  signal: AbortSignal | undefined,
  timer: Timer,
): Promise<WaitForObservationOutcome> => {
  const pollMs = waitFor.pollMs;
  if (waitFor.for === "stable") {
    const settle = await new RealSettleObserve(observeScreen, timer).execute({
      timeoutMs: waitFor.timeout ?? waitFor.timeoutMs,
      pollMs,
      stableReads: waitFor.stableReads,
      signal,
    });
    return {
      observation: settle.observation,
      awaitedElement: undefined,
      awaitDuration: settle.waitMs,
      awaitTimeout: !settle.settled,
      settled: settle.settled,
      // A screen-off capture fast-fails the settle primitive; it did not use
      // the timeout budget, so distinguish it from a genuine timeout.
      timedOut: !settle.settled && settle.observation.wakefulness !== "Asleep",
      polls: settle.polls,
      waitMs: settle.waitMs,
    };
  }

  const finder = new DefaultElementFinder();
  const predicate = buildConditionPredicate(
    finder,
    waitFor.for,
    { elementId: waitFor.elementId, text: waitFor.text, container: waitFor.container },
    { stableReads: waitFor.stableReads },
  );
  const result = await new RealWaitForCondition(observeScreen, timer).execute(predicate, {
    timeoutMs: waitFor.timeout ?? waitFor.timeoutMs,
    pollMs,
    signal,
  });
  return {
    observation: result.observation,
    awaitedElement: result.matchedElement,
    awaitDuration: result.waitMs,
    awaitTimeout: result.timedOut,
    matched: result.matched,
    timedOut: result.timedOut,
    polls: result.polls,
    waitMs: result.waitMs,
    matchedElement: result.matchedElement,
    candidates: result.candidates,
  };
};

const waitForContainerForFinder = (
  waitFor: ObserveWaitForOptions,
): { elementId?: string; text?: string } | null => {
  if (!waitFor.container) {
    return null;
  }
  return "elementId" in waitFor.container
    ? { elementId: waitFor.container.elementId }
    : { text: waitFor.container.text };
};

const isElementCenterOffScreen = (
  element: Element,
  viewHierarchy: ViewHierarchyResult,
): boolean => {
  if (!viewHierarchy.screenWidth || !viewHierarchy.screenHeight || !element.bounds) {
    return false;
  }

  const centerX = (element.bounds.left + element.bounds.right) / 2;
  const centerY = (element.bounds.top + element.bounds.bottom) / 2;
  return (
    centerX < 0 ||
    centerX > viewHierarchy.screenWidth ||
    centerY < 0 ||
    centerY > viewHierarchy.screenHeight
  );
};

export const findWaitForElement = (
  finder: ElementFinder,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult,
  platform?: BootedDevice["platform"],
): Element | null => {
  const container = waitForContainerForFinder(waitFor);

  if (waitFor.elementId !== undefined && !hasRichElementPredicate(waitFor)) {
    return finder.findElementByResourceId(viewHierarchy, waitFor.elementId, container);
  }

  if (waitFor.text !== undefined && !hasRichElementPredicate(waitFor)) {
    return finder.findElementByText(viewHierarchy, waitFor.text, container, true, false);
  }

  if (waitFor.textAny !== undefined) {
    for (const text of waitFor.textAny) {
      const elements = finder.findElementsByText(viewHierarchy, text, container, true, false);
      const element = elements.find(
        (candidate) => !isElementCenterOffScreen(candidate, viewHierarchy),
      );
      if (element) {
        return element;
      }
    }
  }

  if (!hasElementPredicate(waitFor)) {
    return null;
  }

  return findRichWaitForElement(finder, waitFor, viewHierarchy, platform);
};

const hasElementPredicate = (waitFor: ObserveWaitForOptions): boolean =>
  waitFor.elementId !== undefined ||
  waitFor.text !== undefined ||
  waitFor.textAny !== undefined ||
  waitFor.className !== undefined ||
  waitFor.contentDescription !== undefined;

const hasRichElementPredicate = (waitFor: ObserveWaitForOptions): boolean =>
  waitFor.className !== undefined ||
  waitFor.contentDescription !== undefined ||
  waitFor.matchType !== undefined ||
  waitFor.textMatch !== undefined ||
  (waitFor.elementId !== undefined && waitFor.text !== undefined);

const parser = new DefaultElementParser();

const collectCandidateElements = (
  finder: ElementFinder,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult,
): Element[] => {
  const container = waitForContainerForFinder(waitFor);
  const containerNode = container ? finder.findContainerNode(viewHierarchy, container) : null;
  if (container && !containerNode) {
    return [];
  }

  const roots = containerNode
    ? [containerNode]
    : [
        ...parser.extractRootNodes(viewHierarchy),
        ...parser.extractWindowRootNodes(viewHierarchy, "topmost-first"),
      ];
  const elements: Element[] = [];
  for (const root of roots) {
    parser.traverseNode(root, (node) => {
      const element = parser.parseNodeBounds(node);
      if (element) {
        elements.push(element);
      }
    });
  }
  return elements;
};

const getClassName = (element: Element): string | undefined =>
  typeof element.class === "string" ? element.class : undefined;

const getContentDescription = (
  element: Element,
  platform?: BootedDevice["platform"],
): string | undefined =>
  typeof element["content-desc"] === "string"
    ? element["content-desc"]
    : typeof element["ios-accessibility-label"] === "string"
      ? element["ios-accessibility-label"]
      : platform === "ios" && typeof element.text === "string"
        ? element.text
        : undefined;

const textFieldsForElement = (element: Element): string[] =>
  [element.text, element["content-desc"], element["ios-accessibility-label"]].filter(
    (value): value is string => typeof value === "string",
  );

const matchesString = (
  actual: string | undefined,
  expected: string,
  matchMode: "exact" | "contains" | "regex" = "contains",
): boolean => {
  if (actual === undefined) {
    return false;
  }

  if (matchMode === "regex") {
    return new RegExp(expected, "i").test(actual);
  }

  const normalizedActual = normalizeQuotes(actual).toLowerCase();
  const normalizedExpected = normalizeQuotes(expected).toLowerCase();
  return matchMode === "exact"
    ? normalizedActual === normalizedExpected
    : normalizedActual.includes(normalizedExpected);
};

const matchesTextPredicate = (element: Element, waitFor: ObserveWaitForOptions): boolean => {
  if (waitFor.text === undefined) {
    return false;
  }
  return textFieldsForElement(element).some((text) =>
    matchesString(text, waitFor.text!, waitFor.textMatch ?? "contains"),
  );
};

const elementPredicateResults = (
  element: Element,
  waitFor: ObserveWaitForOptions,
  platform?: BootedDevice["platform"],
): boolean[] => {
  const results: boolean[] = [];
  if (waitFor.elementId !== undefined) {
    results.push(element["resource-id"] === waitFor.elementId);
  }
  if (waitFor.text !== undefined) {
    results.push(matchesTextPredicate(element, waitFor));
  }
  if (waitFor.className !== undefined) {
    results.push(getClassName(element) === waitFor.className);
  }
  if (waitFor.contentDescription !== undefined) {
    results.push(
      matchesString(getContentDescription(element, platform), waitFor.contentDescription, "exact"),
    );
  }
  return results;
};

const findRichWaitForElement = (
  finder: ElementFinder,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult,
  platform?: BootedDevice["platform"],
): Element | null => {
  const candidates = collectCandidateElements(finder, waitFor, viewHierarchy).filter(
    (candidate) => !isElementCenterOffScreen(candidate, viewHierarchy),
  );
  const matchType = waitFor.matchType ?? "all";

  for (const candidate of candidates) {
    const results = elementPredicateResults(candidate, waitFor, platform);
    if (results.length === 0) {
      continue;
    }
    const matched = matchType === "any" ? results.some(Boolean) : results.every(Boolean);
    if (matched) {
      return candidate;
    }
  }

  return null;
};

const matchesActiveWindow = (
  observation: ObserveResult,
  waitFor: ObserveWaitForOptions,
  platform?: BootedDevice["platform"],
): boolean => {
  if (!waitFor.activeWindow) {
    return true;
  }

  const activeWindow = observation.activeWindow;
  if (!activeWindow) {
    return false;
  }

  if (
    waitFor.activeWindow.appId !== undefined &&
    activeWindow.appId !== waitFor.activeWindow.appId
  ) {
    return false;
  }

  if (
    platform === "ios" &&
    waitFor.activeWindow.activityName !== undefined &&
    waitFor.activeWindow.appId === undefined
  ) {
    return false;
  }

  if (
    platform !== "ios" &&
    waitFor.activeWindow.activityName !== undefined &&
    activeWindow.activityName !== waitFor.activeWindow.activityName
  ) {
    return false;
  }

  return true;
};

// Absence / negation predicate (issue #3490 §4). Reuses the same element
// matcher: the `absent` fields describe an element that must NOT be present, so
// the predicate is satisfied exactly when no element matches them. Returns true
// (vacuously satisfied) when no `absent` predicate is configured.
const matchesAbsent = (
  finder: ElementFinder,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult,
  platform?: BootedDevice["platform"],
): boolean => {
  if (!waitFor.absent) {
    return true;
  }
  const absentAsWaitFor = {
    ...waitFor.absent,
    container: waitFor.container,
  } as ObserveWaitForOptions;
  return findWaitForElement(finder, absentAsWaitFor, viewHierarchy, platform) === null;
};

const evaluateWaitForObservation = (
  finder: ElementFinder,
  waitFor: ObserveWaitForOptions,
  observation: ObserveResult,
  platform?: BootedDevice["platform"],
): { matched: boolean; awaitedElement?: Element } => {
  const activeWindowMatched = matchesActiveWindow(observation, waitFor, platform);
  const needsElementMatch = hasElementPredicate(waitFor);
  const awaitedElement =
    needsElementMatch && observation.viewHierarchy
      ? findWaitForElement(finder, waitFor, observation.viewHierarchy, platform)
      : null;
  // Without a hierarchy we cannot confirm the absent element is gone, so treat
  // an unconfirmed absence as unsatisfied (keep waiting).
  const absentSatisfied =
    waitFor.absent === undefined
      ? true
      : observation.viewHierarchy
        ? matchesAbsent(finder, waitFor, observation.viewHierarchy, platform)
        : false;

  return {
    matched:
      activeWindowMatched && absentSatisfied && (!needsElementMatch || awaitedElement !== null),
    awaitedElement: awaitedElement ?? undefined,
  };
};

// Compact stable hash of the hierarchy node tree, used only to detect quiet
// (settled) periods. Screen size / window metadata are excluded so cosmetic,
// non-hierarchy churn does not defeat the gate. A missing hierarchy hashes to a
// stable sentinel, so it counts as "quiet". Returns null when the tree cannot be
// hashed, which the settle gate treats as unstable (never settle on it).
const hashHierarchyForSettle = (viewHierarchy?: ViewHierarchyResult): string | null => {
  try {
    return NodeCryptoService.generateCacheKey(JSON.stringify(viewHierarchy?.hierarchy ?? null));
  } catch (error) {
    // Non-serializable hierarchy is unexpected; a constant sentinel would compare
    // equal across consecutive failures and be mistaken for a quiet tree, so
    // return null and let settleReady restart the quiet window instead.
    logger.debug(`[observe] Failed to hash hierarchy for settle gate: ${error}`);
    return null;
  }
};

export const waitForObservation = async (
  observeScreen: ObserveScreen,
  waitFor: WaitForWithSettled,
  signal?: AbortSignal,
  skipBackStack: boolean = false,
  timer: Timer = defaultTimer,
  platform?: BootedDevice["platform"],
): Promise<WaitForObservationOutcome> => {
  const complete = async (
    outcome: WaitForObservationOutcome,
  ): Promise<WaitForObservationOutcome> => {
    if (!shouldSkipObserveWaitForScreenshot()) {
      await observeScreen.captureScreenshot?.(
        createGlobalPerformanceTracker(),
        signal,
        outcome.observation,
      );
    }
    return outcome;
  };

  // Declarative `for` DSL (issue #4398) routes to the #4389 primitives; the
  // legacy element/textAny/activeWindow path below is unchanged (back-compat).
  if (isConditionDsl(waitFor)) {
    return complete(await runWaitForConditionDsl(observeScreen, waitFor, signal, timer));
  }

  const startTime = timer.now();
  const timeoutMs = waitFor.timeout ?? waitFor.timeoutMs ?? 5000;
  const settled = waitFor.settled;
  const finder = new DefaultElementFinder();
  const queryOptions = {
    text: waitFor.text ?? waitFor.textAny?.[0] ?? waitFor.contentDescription,
    elementId: waitFor.elementId,
  };

  // Back-stack collection may stay disabled during waitFor polling to preserve its
  // timeout budget. Screenshots always stay suppressed during polls; when opted
  // in, `complete` captures exactly one screenshot from the terminal state.
  const skipPollingOverhead = !serverConfig.isWaitForPollingOverheadEnabled();

  const observeOnce = () =>
    observeScreen.execute({
      queryOptions,
      perf: createGlobalPerformanceTracker(),
      skipWaitForFresh: false,
      minTimestamp: startTime,
      signal,
      skipBackStack: skipPollingOverhead || skipBackStack,
      skipScreenshot: true,
      skipAccessibilityAudit: true,
    });

  // Settle gate (issue #3490 §3): once the predicate matches, hold until the
  // hierarchy hash is unchanged for settled.quietPeriodMs. `matchedHash === null`
  // means "no stable candidate yet"; a changed hash restarts the quiet window.
  let matchedHash: string | null = null;
  let quietStart = startTime;
  const settleReady = (observation: ObserveResult): boolean => {
    if (!settled) {
      return true;
    }
    const hash = hashHierarchyForSettle(observation.viewHierarchy);
    // An unhashable tree (null) is never quiet: fall through to restart the
    // window so the gate cannot resolve early on an unverifiable snapshot.
    if (hash === null || matchedHash === null || hash !== matchedHash) {
      matchedHash = hash;
      quietStart = timer.now();
      return false;
    }
    return timer.now() - quietStart >= settled.quietPeriodMs;
  };

  throwIfAborted(signal);
  let observation = await observeOnce();
  let polls = 1;
  let waitEvaluation = evaluateWaitForObservation(finder, waitFor, observation, platform);

  if (waitEvaluation.matched && settleReady(observation)) {
    const waitMs = timer.now() - startTime;
    return complete({
      observation,
      awaitedElement: waitEvaluation.awaitedElement,
      awaitDuration: waitMs,
      awaitTimeout: false,
      matched: true,
      settled: settled ? true : undefined,
      timedOut: false,
      polls,
      waitMs,
      matchedElement: waitEvaluation.awaitedElement,
    });
  }
  if (!waitEvaluation.matched) {
    matchedHash = null;
  }

  if (timer.now() - startTime >= timeoutMs) {
    const waitMs = timer.now() - startTime;
    return complete({
      observation,
      awaitDuration: waitMs,
      awaitTimeout: true,
      matched: false,
      settled: settled ? false : undefined,
      timedOut: true,
      polls,
      waitMs,
    });
  }

  while (timer.now() - startTime < timeoutMs) {
    await timer.sleep(WAIT_FOR_POLL_INTERVAL_MS);
    throwIfAborted(signal);

    observation = await observeOnce();
    polls++;
    waitEvaluation = evaluateWaitForObservation(finder, waitFor, observation, platform);

    if (waitEvaluation.matched) {
      if (settleReady(observation)) {
        const waitMs = timer.now() - startTime;
        return complete({
          observation,
          awaitedElement: waitEvaluation.awaitedElement,
          awaitDuration: waitMs,
          awaitTimeout: false,
          matched: true,
          settled: settled ? true : undefined,
          timedOut: false,
          polls,
          waitMs,
          matchedElement: waitEvaluation.awaitedElement,
        });
      }
    } else {
      matchedHash = null;
    }
  }

  const waitMs = timer.now() - startTime;
  return complete({
    observation,
    awaitDuration: waitMs,
    awaitTimeout: true,
    matched: false,
    settled: settled ? false : undefined,
    timedOut: true,
    polls,
    waitMs,
  });
};

// Register tools (this will be called when this file is imported)
export function registerObserveTools() {
  // Observe handler
  const observeHandler = async (
    device: BootedDevice,
    args: ObserveArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ): Promise<StructuredToolResponse<ObserveToolPayload>> => {
    const waitFor = args.waitFor;
    // #6154 follow-up: `platform` is optional on the wire, so the schema's
    // iOS-rejects-activityName check (which runs against the raw request
    // platform) can be skipped entirely when the caller omitted it. Re-validate
    // against the resolved `device.platform`, before the try/catch below so the
    // actionable message isn't re-wrapped as a generic execution failure.
    assertActiveWindowWaitForSupportedOnPlatform(device.platform, waitFor);
    try {
      const observeScreen = new RealObserveScreen(device);
      // ObserveScreen.execute() rejects stale cross-platform hierarchies at the
      // source, so every observation reaching here is already platform-validated
      // (raw-mode append below is likewise gated on a validated primary hierarchy).
      const waitOutcome = waitFor
        ? await waitForObservation(
            observeScreen,
            { ...waitFor, settled: args.settled },
            signal,
            args.skipBackStack ?? false,
            defaultTimer,
            device.platform,
          )
        : null;
      const result = waitOutcome
        ? waitOutcome.observation
        : await observeScreen.execute({
            perf: createGlobalPerformanceTracker(),
            skipWaitForFresh: true,
            signal,
          });

      if (args.raw) {
        await observeScreen.appendRawViewHierarchy(result, signal);
      }

      // Include setup timing if this is the first observe after accessibility service setup
      const setupTiming = consumeSetupTiming(device.deviceId);
      if (setupTiming && result.perfTiming) {
        // Prepend setup timing to the observe timing
        result.perfTiming = [setupTiming, ...result.perfTiming];
      } else if (setupTiming) {
        result.perfTiming = [setupTiming];
      }

      // Record back stack information in navigation graph if available
      if (result.backStack && result.activeWindow?.appId) {
        const navGraph = args.sessionUuid
          ? NavigationGraphManager.getInstanceForSession(args.sessionUuid)
          : NavigationGraphManager.getInstance();
        // Only record if we have a current app and screen
        if (
          navGraph.getCurrentAppId() === result.activeWindow.appId &&
          navGraph.getCurrentScreen()
        ) {
          navGraph.recordBackStack(result.backStack);
        }
      }

      // If accessibility service reports as disabled, reset setup state to force reinstall on next attempt
      // This handles cases where the service was uninstalled externally
      if (device.platform === "android" && result.accessibilityState?.enabled === false) {
        logger.warn(
          "[observe] Accessibility service not enabled, resetting setup state for next attempt",
        );
        try {
          const manager = AndroidCtrlProxyManager.getInstance(device);
          manager.resetSetupState();
        } catch (error) {
          logger.warn("[observe] Failed to reset accessibility setup state", {
            error: errorMessage(error),
          });
        }
      }

      // Notify MCP clients that observation resources have been updated
      await ResourceRegistry.notifyResourcesUpdated([
        RESOURCE_URIS.LATEST_OBSERVATION,
        RESOURCE_URIS.LATEST_SCREENSHOT,
      ]);

      if (waitOutcome) {
        const waitMetadata: Omit<WaitForObservationOutcome, "observation"> = {
          awaitedElement: waitOutcome.awaitedElement,
          awaitDuration: waitOutcome.awaitDuration,
          awaitTimeout: waitOutcome.awaitTimeout,
          matched: waitOutcome.matched,
          settled: waitOutcome.settled,
          timedOut: waitOutcome.timedOut,
          polls: waitOutcome.polls,
          waitMs: waitOutcome.waitMs,
          matchedElement: waitOutcome.matchedElement,
          candidates: waitOutcome.candidates,
        };
        return createStructuredToolResponse({
          ...result,
          ...waitMetadata,
        });
      }

      return createStructuredToolResponse(result);
    } catch (error) {
      throw new ActionableError(`Failed to execute observe: ${error}`);
    }
  };

  const identifyInteractionsHandler = async (
    device: BootedDevice,
    args: IdentifyInteractionsOptions,
  ) => {
    try {
      const observeScreen = new RealObserveScreen(device);
      const cachedResult = await observeScreen.getMostRecentCachedObserveResult();
      const navigationGraph = args.sessionUuid
        ? NavigationGraphManager.getInstanceForSession(args.sessionUuid)
        : NavigationGraphManager.getInstance();
      const currentScreen = navigationGraph.getCurrentScreen();
      const navigationEdges =
        args.includeContext?.navigationGraph !== false && currentScreen
          ? await navigationGraph.getEdgesFrom(currentScreen)
          : [];

      const analyzer = new IdentifyInteractions();
      const result = analyzer.analyze(cachedResult, args, currentScreen, navigationEdges);

      return createJSONToolResponse(result);
    } catch (error) {
      throw new ActionableError(`Failed to execute identifyInteractions: ${error}`);
    }
  };

  // Register with the tool registry using the new device-aware method.
  // Advertise a machine-readable `ObserveResult` outputSchema (issue #3025) so
  // observe's hierarchy/window/element bounds — the bulk of compacted bounds —
  // are described on the wire, and so its `bounds` fields route through
  // `elementBoundsSchema` (the compact bounds tuple is advertised unconditionally
  // via `advertiseBoundsForCompact` in `getToolDefinitions`). Composes with
  // `--tool-results-no-structured-content`, which suppresses the advertisement.
  ToolRegistry.registerDeviceAware(
    "observe",
    "Get screen view hierarchy",
    observeSchema,
    observeHandler,
    {
      defaultEnabled: true,
      outputSchema: observeToolResultSchema,
      appUiResourceUri: OBSERVE_APP_RESOURCE_URI,
    },
  );

  ToolRegistry.registerDeviceAware(
    "identifyInteractions",
    "Suggest likely interactions",
    identifyInteractionsSchema,
    identifyInteractionsHandler,
    { defaultEnabled: true, debugOnly: true },
  );
}
