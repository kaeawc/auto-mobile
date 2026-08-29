import { z } from "zod/v4";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { TapOnElement } from "../features/action/TapOnElement";
import { TapAnyElement } from "../features/action/TapAnyElement";
import { InputText } from "../features/action/InputText";
import { WakeAndUnlock } from "../features/action/WakeAndUnlock";
import { DeviceLockStore } from "../features/action/DeviceLockStore";
import { IosLockScreenUnlocker } from "../features/action/IosLockScreenUnlocker";
import { ClearText } from "../features/action/ClearText";
import { SelectAllText } from "../features/action/SelectAllText";
import { PressButton } from "../features/action/PressButton";
import { DragAndDrop } from "../features/action/DragAndDrop";
import { SwipeOn } from "../features/action/swipeon";
import { PinchOn } from "../features/action/PinchOn";
import { Shake } from "../features/action/Shake";
import { ImeAction } from "../features/action/ImeAction";
import { RecentApps } from "../features/action/RecentApps";
import { HomeScreen } from "../features/action/HomeScreen";
import { Rotate } from "../features/action/Rotate";
import { OpenURL } from "../features/action/OpenURL";
import { Clipboard } from "../features/action/Clipboard";
import { Keyboard } from "../features/action/Keyboard";
import {
  ActionableError,
  BootedDevice,
  ClipboardResult,
  OpenURLResult,
  SwipeOnToolPayload,
  type TapOnSelectedElement,
} from "../models";
import { ListInstalledApps } from "../features/observe/ListInstalledApps";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import {
  overrideWaitForJsonSchema,
  refineWaitForArgs,
  settledSchema,
  waitForObservation,
  type WaitForObservationOutcome,
  waitForSchema,
} from "./observeTools";
import { defaultTimer } from "../utils/SystemTimer";
import {
  createJSONToolResponse,
  createStructuredToolResponse,
  StructuredToolResponse,
} from "../utils/toolUtils";
import { resolveSwipeDirection } from "../utils/swipeOnUtils";
import { RecompositionTracker } from "../features/performance/RecompositionTracker";
import {
  addDeviceTargetingToSchema,
  platformSchema,
  withAppIdAliases,
  withJsonSchemaOverride,
  compactExclusiveSelectorProperties,
} from "./toolSchemaHelpers";
import { serverConfig } from "../utils/ServerConfig";
import {
  createElementIdTextSelectorSchema,
  elementContainerSchema,
  elementSelectionStrategySchema,
} from "./elementSelectorSchemas";
import { tapOnResultSchema } from "./toolOutputSchemas";

// Import from extracted modules
import type {
  ClearTextArgs,
  SelectAllTextArgs,
  PressButtonArgs,
  SystemTrayNotificationArgs,
  SystemTrayArgs,
  InputTextArgs,
  WakeAndUnlockArgs,
  OpenLinkArgs,
  TapOnArgs,
  TapAnyArgs,
  DragAndDropArgs,
  SwipeOnArgs,
  PinchOnArgs,
  ShakeArgs,
  ImeActionArgs,
  KeyboardArgs,
  RecentAppsArgs,
  RotateArgs,
  ClipboardArgs,
} from "./interactionToolTypes";

import {
  SystemTrayObserver,
  SystemTrayAdb,
  SystemTrayDependencies,
  setSystemTrayDependencies,
  resetSystemTrayDependencies,
  getSystemTrayDependencies,
  waitForNotificationMatch,
  resolveSystemTrayAwaitTimeout,
  ensureSystemTrayOpen,
  ensureSystemTrayClosed,
  resolveNotificationTapElement,
  resolveNotificationSwipeElement,
  tapElement,
  swipeElement,
  resolveAppLabel,
  isMatchInCollapsedGroup,
  expandNotificationGroup,
  SYSTEM_TRAY_CLEAR_MAX_ITERATIONS,
  SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS,
  EXPAND_GROUP_SETTLE_MS,
} from "./systemTrayHelpers";

// Re-export types for backward compatibility
export type {
  ClearTextArgs,
  SelectAllTextArgs,
  PressButtonArgs,
  SystemTrayNotificationArgs,
  SystemTrayArgs,
  InputTextArgs,
  WakeAndUnlockArgs,
  OpenLinkArgs,
  TapOnArgs,
  TapAnyArgs,
  DragAndDropArgs,
  SwipeOnArgs,
  PinchOnArgs,
  ShakeArgs,
  ImeActionArgs,
  KeyboardArgs,
  RecentAppsArgs,
  RotateArgs,
  ClipboardArgs,
};

// Re-export system tray helpers for backward compatibility
export type { SystemTrayObserver, SystemTrayAdb, SystemTrayDependencies };

export { setSystemTrayDependencies, resetSystemTrayDependencies, waitForNotificationMatch };

// ============================================================================
// Schema Definitions
// ============================================================================

export const shakeSchema = addDeviceTargetingToSchema(
  z.object({
    duration: z.number().optional().describe("Shake duration ms (default 1000)"),
    intensity: z.number().optional().describe("Shake intensity (Android; default 100)"),
    platform: platformSchema,
  }),
);

export const keyboardSchema = addDeviceTargetingToSchema(
  z.object({
    action: z.enum(["open", "close", "detect"]).describe("Keyboard action"),
    platform: platformSchema,
  }),
);

const tapOnSelectorSchema = z
  .union([
    z
      .object({ elementId: z.string().min(1).describe("Resource ID, e.g. com.app:id/btn_login") })
      .strict(),
    z.object({ testTag: z.string().min(1).describe("Android accessibility test tag") }).strict(),
    z.object({ text: z.string().min(1).describe("Text, content-desc, or placeholder") }).strict(),
    z
      .object({
        accessibilityLink: z
          .string()
          .trim()
          .min(1)
          .describe("Exact visible text of a semantic accessibility link"),
      })
      .strict(),
    z
      .object({
        textAny: z
          .array(z.string().min(1))
          .min(1)
          .describe("Ordered text variants; first visible match wins"),
      })
      .strict(),
  ])
  .describe(
    "Element to tap: elementId, Android testTag, text, semantic accessibility link, or ordered text variants",
  );

export const tapOnSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        selector: tapOnSelectorSchema,
        sibling: z
          .boolean()
          .optional()
          .describe("Tap a clickable sibling of the match, e.g. checkbox beside label"),
        container: elementContainerSchema.optional().describe("Scope search to a container"),
        action: z
          .enum(["tap", "doubleTap", "longPress", "focus"])
          .default("tap")
          .describe("Action type (default: tap)"),
        selectionStrategy: elementSelectionStrategySchema
          .optional()
          .describe("Selection strategy when multiple match (default: first)"),
        index: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "0-based index to tap the Nth on-screen match (in hierarchy order, i.e. top-to-bottom " +
              "for a vertical list) instead of applying " +
              "selectionStrategy — for repeated controls with no unique text. Out of range → no match.",
          ),
        // A negative duration used to be accepted and silently degraded a
        // longPress into a plain tap (#5769); bound it like the sibling params.
        duration: z.number().min(0, "must be >= 0").optional().describe("Long press duration (ms)"),
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
              .describe("Polling duration (ms, default: 500)"),
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
        platform: platformSchema,
      })
      .strict(),
  ).superRefine((value, ctx) => {
    const isDirectLink = "accessibilityLink" in value.selector;
    if (!isDirectLink && !value.subtext) {
      return;
    }
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
    addIssue(
      isDirectLink && value.subtext,
      "accessibilityLink and subtext cannot be used together",
      ["subtext"],
    );
    addIssue(value.action !== "tap", "semantic link activation supports only the tap action", [
      "action",
    ]);
    addIssue(value.sibling, "semantic link activation cannot use sibling", ["sibling"]);
    addIssue(
      value.retryIfNoChange || value.ensureTap,
      "semantic link activation cannot retry an acknowledged link activation",
      value.retryIfNoChange ? ["retryIfNoChange"] : ["ensureTap"],
    );
    addIssue(value.searchUntil, "semantic link activation cannot use searchUntil", ["searchUntil"]);
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
    js.if = {
      anyOf: [
        { required: ["subtext"] },
        {
          properties: {
            selector: { required: ["accessibilityLink"] },
          },
        },
      ],
    };
    js.then = {
      properties: {
        action: { const: "tap" },
        sibling: { not: { const: true } },
        retryIfNoChange: { not: { const: true } },
        ensureTap: { not: { const: true } },
        searchUntil: { not: {} },
      },
      allOf: [
        {
          not: {
            required: ["subtext"],
            properties: {
              selector: { required: ["accessibilityLink"] },
            },
          },
        },
        {
          if: { required: ["subtext"] },
          then: { not: { required: ["index"] } },
        },
        {
          if: { required: ["subtext"] },
          then: {
            properties: {
              selectionStrategy: { not: { const: "random" } },
            },
          },
        },
      ],
    };
  },
);

export const tapAnySchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        container: elementContainerSchema.optional().describe("Scope search to a container"),
        selectionStrategy: elementSelectionStrategySchema
          .optional()
          .describe("Element selection strategy: 'first' (default) or 'random'"),
        scrollableContainer: z
          .boolean()
          .optional()
          .describe("Search only scrollable containers/lists"),
        action: z
          .enum(["tap", "doubleTap", "longPress"])
          .default("tap")
          .describe("Action type (default: tap)"),
        // Bounded like tapOn.duration so a negative longPress cannot silently
        // become a plain tap (#5769).
        duration: z.number().min(0, "must be >= 0").optional().describe("Long press duration (ms)"),
        searchUntil: z
          .object({
            duration: z
              .number()
              .min(100)
              .max(12000)
              .optional()
              .describe("Polling duration (ms, default: 500)"),
          })
          .optional()
          .describe("Poll for clickable element before tapping"),
        platform: platformSchema,
      })
      .strict(),
  ),
  (js) => compactExclusiveSelectorProperties(js, ["container"]),
);

const dragAndDropSelectorSchema = (label: "Source" | "Target") =>
  createElementIdTextSelectorSchema({
    elementId: `${label} ID`,
    text: `${label} text`,
  }).describe(`${label} element`);

const swipeOnLookForSchema = createElementIdTextSelectorSchema({
  elementId: "ID of the element to look for",
  text: "Text to look for",
});

export const dragAndDropSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z.object({
      source: dragAndDropSelectorSchema("Source"),
      target: dragAndDropSelectorSchema("Target"),
      pressDurationMs: z
        .number()
        .min(600)
        .max(3000)
        .optional()
        .describe("Press duration ms (min: 600, max: 3000, default: 600)"),
      dragDurationMs: z
        .number()
        .min(300)
        .max(1000)
        .optional()
        .describe("Drag duration ms (min: 300, max: 1000, default: 300)"),
      holdDurationMs: z
        .number()
        .min(100)
        .max(3000)
        .optional()
        .describe("Hold duration ms (min: 100, max: 3000, default: 100)"),
      platform: platformSchema,
    }),
  ),
  (js) => compactExclusiveSelectorProperties(js, ["source", "target"]),
);

export const swipeOnSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z.object({
      includeSystemInsets: z
        .boolean()
        .optional()
        .describe("Use full screen including status/nav bars"),
      container: elementContainerSchema.optional().describe("Scope search to a container"),
      autoTarget: z
        .boolean()
        .optional()
        .describe("Auto-target scrollable containers (default: true)"),
      direction: z.enum(["up", "down", "left", "right"]).describe("Swipe/scroll direction"),
      gestureType: z
        .enum(["swipeFingerTowardsDirection", "scrollTowardsDirection"])
        .optional()
        .describe("Finger direction or content scroll direction; default: scrollTowardsDirection"),
      lookFor: swipeOnLookForSchema.optional().describe("Element to look for during swipe"),
      boomerang: z.boolean().optional().describe("Return to start position after swipe apex"),
      apexPause: z
        .number()
        .min(0)
        .max(3000)
        .optional()
        .describe("Pause duration at swipe apex in ms (0-3000)"),
      returnSpeed: z
        .number()
        .min(0.1)
        .max(3.0)
        .optional()
        .describe("Speed multiplier for return swipe (0.1-3.0)"),
      speed: z.enum(["slow", "normal", "fast"]).optional().describe("Swipe speed preset"),
      platform: platformSchema,
    }),
  ),
  (js) => compactExclusiveSelectorProperties(js, ["container", "lookFor"]),
);

export const pinchOnSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z.object({
      direction: z.enum(["in", "out"]).describe("Pinch direction"),
      distanceStart: z.number().optional().describe("Initial finger distance (px, default: 400)"),
      distanceEnd: z.number().optional().describe("Final finger distance (px, default: 100)"),
      scale: z.number().optional().describe("Scale factor (overrides distances)"),
      duration: z.number().optional().describe("Gesture duration (ms)"),
      rotationDegrees: z
        .number()
        .optional()
        .describe(
          "Degrees the two-finger axis rotates during the pinch (default: 0). The axis starts horizontal and ends rotated by this amount — a combined pinch+rotate, not a pinch along a fixed rotated axis. Same convention on Android and iOS.",
        ),
      includeSystemInsets: z
        .boolean()
        .optional()
        .describe("Use full screen including status/nav bars"),
      container: elementContainerSchema.optional().describe("Scope search to a container"),
      autoTarget: z.boolean().optional().describe("Auto-target pinchable containers"),
      platform: platformSchema,
    }),
  ),
  (js) => compactExclusiveSelectorProperties(js, ["container"]),
);

export const clearTextSchema = addDeviceTargetingToSchema(
  z.object({
    platform: platformSchema,
  }),
);

export const selectAllTextSchema = addDeviceTargetingToSchema(
  z.object({
    platform: platformSchema,
  }),
);

export const pressButtonSchema = addDeviceTargetingToSchema(
  z.object({
    button: z.enum(["home", "back", "menu", "power", "volume_up", "volume_down", "recent"]),
    platform: platformSchema,
  }),
);

const systemTrayNotificationSchema = z.object({
  title: z.string().optional().describe("Notification title to match"),
  body: z.string().optional().describe("Notification body to match"),
  appId: z.string().optional().describe("App package ID to match"),
  tapActionLabel: z.string().optional().describe("Action button label to tap (for 'tap' action)"),
});

const systemTraySchemaBase = z.object({
  action: z
    .enum(["open", "close", "find", "tap", "dismiss", "clearAll"])
    .describe("open/close/find/tap/dismiss/clearAll notification"),
  notification: systemTrayNotificationSchema.optional().describe("Notification criteria to match"),
  awaitTimeout: z
    .number()
    .optional()
    .describe("Timeout in ms to wait for notification (default: 5000)"),
  platform: platformSchema,
});

export const systemTraySchema = withAppIdAliases(
  addDeviceTargetingToSchema(systemTraySchemaBase).superRefine((value, ctx) => {
    const notification = value.notification ?? {};

    if (value.action === "open" || value.action === "close") {
      return;
    }

    const hasCriteria = notification.title || notification.body || notification.appId;
    if (!hasCriteria) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.action} action requires at least one notification criteria (title, body, or appId)`,
      });
    }

    if (value.action === "clearAll" && !notification.appId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "clearAll action requires notification.appId",
      });
    }

    if (notification.tapActionLabel && value.action !== "tap") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "notification.tapActionLabel is only valid for tap action",
      });
    }
  }),
);

export const stopAppSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z.object({
      appId: z.string(),
      platform: platformSchema,
    }),
  ),
);

export const clearStateSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z.object({
      appId: z.string(),
      clearKeychain: z.boolean().optional().describe("Clear iOS keychain"),
      platform: platformSchema,
    }),
  ),
);

export const inputTextSchema = addDeviceTargetingToSchema(
  z.object({
    text: z.string().min(1),
    mode: z
      .enum(["a11y", "eventLast", "eventAll", "eventOnly"])
      .optional()
      .describe(
        "Android text mode: a11y default; eventLast and eventAll start with accessibility setText; eventOnly clears and types supported ASCII with key events only",
      ),
    imeAction: z
      .enum(["done", "next", "search", "send", "go", "previous"])
      .optional()
      .describe("IME action after input"),
    dismissKeyboard: z.boolean().optional().describe("Android: dismiss keyboard after input"),
    platform: platformSchema,
  }),
);

export const wakeAndUnlockSchema = addDeviceTargetingToSchema(
  z.object({
    pin: z
      .string()
      .optional()
      .describe(
        "Credential to unlock a secure Android device. Optional; logically required to unlock a secure lock unless a pin was already remembered this session. Ignored on iOS.",
      ),
    platform: platformSchema,
  }),
);

// openLink gains an optional integrated waitFor (issue #3490 §5): after opening
// the URL, poll for the predicate — reusing observe's waitFor/settled schema and
// semantics — so the open→settle→observe→verify workaround collapses into one call.
export const openLinkSchema = withAppIdAliases(
  withJsonSchemaOverride(
    addDeviceTargetingToSchema(
      z.object({
        url: z.string().describe("URL to open"),
        platform: platformSchema,
        waitFor: waitForSchema
          .optional()
          .describe("After opening, wait for this predicate before returning the observation"),
        settled: settledSchema
          .optional()
          .describe("After waitFor matches, wait for a quiet hierarchy period (requires waitFor)"),
      }),
    ).superRefine(refineWaitForArgs),
    overrideWaitForJsonSchema,
  ),
);

/** Outcome of a post-open waitFor poll, as produced by {@link waitForObservation}. */
export type OpenLinkWaitOutcome = WaitForObservationOutcome;

/**
 * Build the openLink response payload. Without a wait it is the plain open
 * result; with a wait (issue #3490 §5) the awaited observation replaces the
 * open-time snapshot and the await metadata is surfaced to the caller.
 */
export const buildOpenLinkPayload = (
  url: string,
  openResult: OpenURLResult,
  waitOutcome: OpenLinkWaitOutcome | null,
) => {
  if (!waitOutcome) {
    return {
      message: `Opened link ${url}`,
      ...openResult,
      observation: openResult.observation,
    };
  }
  return {
    message: `Opened link ${url}`,
    ...openResult,
    observation: waitOutcome.observation,
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
};

export const imeActionSchema = addDeviceTargetingToSchema(
  z.object({
    action: z.enum(["done", "next", "search", "send", "go", "previous"]).describe("IME action"),
    platform: platformSchema,
  }),
);

export const recentAppsSchema = addDeviceTargetingToSchema(
  z.object({
    platform: platformSchema,
  }),
);

export const homeScreenSchema = addDeviceTargetingToSchema(
  z.object({
    platform: platformSchema,
  }),
);

export const rotateSchema = addDeviceTargetingToSchema(
  z.object({
    orientation: z.enum(["portrait", "landscape"]),
    platform: platformSchema,
  }),
);

const clipboardTextRequiredMessage = "text is required when action is copy";
const optionalClipboardTextSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Text to copy (required for 'copy' action)");
const clipboardPlatformSchema = {
  platform: platformSchema,
};

export const clipboardSchema = z.discriminatedUnion("action", [
  addDeviceTargetingToSchema(
    z.object({
      action: z.literal("copy").describe("Clipboard action"),
      text: z
        .string({ error: clipboardTextRequiredMessage })
        .min(1, clipboardTextRequiredMessage)
        .describe("Text to copy (required for 'copy' action)"),
      ...clipboardPlatformSchema,
    }),
  ),
  addDeviceTargetingToSchema(
    z.object({
      action: z.literal("paste").describe("Clipboard action"),
      text: optionalClipboardTextSchema,
      ...clipboardPlatformSchema,
    }),
  ),
  addDeviceTargetingToSchema(
    z.object({
      action: z.literal("clear").describe("Clipboard action"),
      text: optionalClipboardTextSchema,
      ...clipboardPlatformSchema,
    }),
  ),
  addDeviceTargetingToSchema(
    z.object({
      action: z.literal("get").describe("Clipboard action"),
      text: optionalClipboardTextSchema,
      ...clipboardPlatformSchema,
    }),
  ),
]);

export function formatClipboardMessage(result: ClipboardResult): string {
  if (!result.success) {
    return `Failed to execute clipboard ${result.action}: ${result.error ?? "unknown error"}`;
  }

  switch (result.action) {
    case "copy":
      return "Copied text to clipboard";
    case "paste":
      return "Pasted clipboard content into focused field";
    case "clear":
      return "Cleared clipboard";
    case "get":
      return result.text
        ? `Retrieved clipboard content: "${result.text.substring(0, 50)}${result.text.length > 50 ? "..." : ""}"`
        : "Retrieved empty clipboard";
  }
}

export function formatRecentAppsMessage(result: { success?: boolean; error?: string }): string {
  if (result.success === false) {
    return `Failed to open recent apps: ${result.error ?? "unknown error"}`;
  }
  return "Opened recent apps";
}

export function formatSwipeOnMessage(
  result: Pick<SwipeOnToolPayload, "success" | "error" | "found" | "scrollIterations">,
  direction: string,
): string {
  if (!result.success) {
    // `||` not `??`: an empty-string error (`error: ""`) must still yield the
    // non-empty fallback, otherwise the tool returns a blank message (#4183 P4).
    return result.error || `Swipe ${direction} failed`;
  }
  return result.found
    ? `Swiped ${direction} and found element after ${result.scrollIterations ?? 1} swipe(s)`
    : `Swiped ${direction}`;
}

/**
 * Build the tapOn success message so it says *what* it matched, not just
 * "Tapped on element" (#5868). A correct tap and a wrong tap were byte-identical;
 * now the message carries the resolved match identity and match count (so an
 * ambiguous selector is distinguishable from a precise one) alongside the
 * existing hierarchy-changed search summary. The structured `selectedElement`
 * (resourceId/text/bounds/totalMatches) still rides on the result for clients
 * that read the payload.
 */
export function buildTapOnResultMessage(
  selectedElement: TapOnSelectedElement | undefined,
  searchSummary: string | undefined,
  activatedSubtext?: { text: string; occurrence: number },
): string {
  const details: string[] = [];
  if (selectedElement) {
    // Include every available identity field, not just the resource id: Android
    // list rows commonly reuse an id such as `...:id/title`, so the id alone can't
    // tell "Internet" from "Calendar" — the text can.
    const identity: string[] = [];
    if (selectedElement.resourceId) {
      identity.push(`id=${selectedElement.resourceId}`);
    }
    if (selectedElement.testTag) {
      identity.push(`testTag=${selectedElement.testTag}`);
    }
    if (selectedElement.text) {
      identity.push(`text=${JSON.stringify(selectedElement.text)}`);
    }
    details.push(`matched ${identity.length > 0 ? identity.join(" ") : "element"}`);
    const count = selectedElement.totalMatches;
    // For an ambiguous selector, name which occurrence was tapped so index 0 vs 2
    // (or a random pick) among identical rows is distinguishable.
    const index = count > 1 ? ` (index ${selectedElement.indexInMatches})` : "";
    details.push(`${count} ${count === 1 ? "match" : "matches"}${index}`);
  }
  // Append the activated semantic link whenever present, additively: an
  // owner-scoped subtext tap resolves BOTH an owner (selectedElement) and the
  // activated link, and the accessibilityLink selector resolves only the link —
  // either way, naming the link keeps taps on different links from being
  // byte-identical.
  if (activatedSubtext) {
    const occurrence =
      activatedSubtext.occurrence > 0 ? ` [occurrence ${activatedSubtext.occurrence}]` : "";
    details.push(`activated link ${JSON.stringify(activatedSubtext.text)}${occurrence}`);
  }
  if (searchSummary) {
    details.push(searchSummary);
  }
  return details.length > 0 ? `Tapped on element (${details.join("; ")})` : "Tapped on element";
}

// ============================================================================
// Tool Registration
// ============================================================================

export function registerInteractionTools() {
  // Tap on handler
  const tapOnHandler = async (
    device: BootedDevice,
    args: TapOnArgs,
    progress?: ProgressCallback,
  ) => {
    RecompositionTracker.getInstance().recordInteraction();
    const tapOnTextCommand = new TapOnElement(device);
    const result = await tapOnTextCommand.execute(
      {
        container: args.container,
        text: args.selector.text,
        textAny: args.selector.textAny,
        elementId: args.selector.elementId,
        testTag: args.selector.testTag,
        accessibilityLink: args.selector.accessibilityLink,
        sibling: args.sibling,
        selectionStrategy: args.selectionStrategy,
        index: args.index,
        action: args.action,
        duration: args.duration,
        searchUntil: args.searchUntil,
        preTapStability: args.preTapStability,
        retryIfNoChange: args.retryIfNoChange,
        ensureTap: args.ensureTap,
        subtext: args.subtext,
      },
      progress,
    );

    const searchStats = result.searchUntil;
    const freshness = result.observation?.freshness;
    const hasFreshnessTimestamp =
      typeof freshness?.requestedAfter === "number" &&
      typeof freshness?.actualTimestamp === "number";
    const hasConfirmedFreshObservation =
      hasFreshnessTimestamp && freshness.actualTimestamp >= freshness.requestedAfter;
    const shouldIncludeSearchSummary =
      Boolean(searchStats) &&
      (searchStats.requestCount > 0 ||
        searchStats.changeCount > 0 ||
        (Boolean(args.searchUntil) && hasConfirmedFreshObservation));
    const searchSummary =
      shouldIncludeSearchSummary && searchStats
        ? `${searchStats.changeCount} view hierarchy changes over ${searchStats.requestCount} requests within ${searchStats.durationMs}ms`
        : undefined;

    return createStructuredToolResponse({
      message: buildTapOnResultMessage(
        result.selectedElement,
        searchSummary,
        result.activatedSubtext,
      ),
      observation: result.observation,
      ...result,
    });
  };

  // TapAny handler
  const tapAnyHandler = async (
    device: BootedDevice,
    args: TapAnyArgs,
    progress?: ProgressCallback,
  ) => {
    RecompositionTracker.getInstance().recordInteraction();
    const tapAnyCommand = new TapAnyElement(device);
    const result = await tapAnyCommand.execute(
      {
        container: args.container,
        selectionStrategy: args.selectionStrategy,
        scrollableContainer: args.scrollableContainer,
        action: args.action,
        duration: args.duration,
        searchUntil: args.searchUntil,
      },
      progress,
    );

    const searchStats = result.searchUntil;
    const shouldIncludeSearchSummary =
      Boolean(searchStats) && (searchStats!.requestCount > 0 || searchStats!.changeCount > 0);
    const searchSummary =
      shouldIncludeSearchSummary && searchStats
        ? `${searchStats.changeCount} view hierarchy changes over ${searchStats.requestCount} requests within ${searchStats.durationMs}ms`
        : undefined;

    return createStructuredToolResponse({
      message: searchSummary
        ? `Tapped clickable element (${searchSummary})`
        : "Tapped clickable element",
      observation: result.observation,
      ...result,
    });
  };

  // Drag and drop handler
  const dragAndDropHandler = async (
    device: BootedDevice,
    args: DragAndDropArgs,
    progress?: ProgressCallback,
  ) => {
    RecompositionTracker.getInstance().recordInteraction();
    const dragAndDrop = new DragAndDrop(device);
    const result = await dragAndDrop.execute(
      {
        source: args.source,
        target: args.target,
        pressDurationMs: args.pressDurationMs,
        dragDurationMs: args.dragDurationMs,
        holdDurationMs: args.holdDurationMs,
      },
      progress,
    );

    return createJSONToolResponse({
      message: "Dragged element to target",
      observation: result.observation,
      ...result,
    });
  };

  // Clear text handler
  const clearTextHandler = async (
    device: BootedDevice,
    args: ClearTextArgs,
    progress?: ProgressCallback,
  ) => {
    try {
      const clearText = new ClearText(device);
      const result = await clearText.execute(progress);

      return createJSONToolResponse({
        message: "Cleared text from input field",
        observation: result.observation,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to clear text: ${error}`);
    }
  };

  // Select all text handler
  const selectAllTextHandler = async (
    device: BootedDevice,
    args: SelectAllTextArgs,
    progress?: ProgressCallback,
  ) => {
    try {
      const selectAllText = new SelectAllText(device);
      const result = await selectAllText.execute(progress);

      return createJSONToolResponse({
        message: "Selected all text in focused input field",
        observation: result.observation,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to select all text: ${error}`);
    }
  };

  // Press button handler
  const pressButtonHandler = async (
    device: BootedDevice,
    args: PressButtonArgs,
    progress?: ProgressCallback,
  ) => {
    RecompositionTracker.getInstance().recordInteraction();
    try {
      const pressButton = new PressButton(device);
      const result = await pressButton.execute(args.button, progress);

      return createJSONToolResponse({
        message: `Pressed button ${args.button}`,
        observation: result.observation,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to press button: ${error}`);
    }
  };

  // System tray handler
  const systemTrayHandler = async (
    device: BootedDevice,
    args: SystemTrayArgs,
    progress?: ProgressCallback,
  ) => {
    try {
      const awaitTimeoutMs = resolveSystemTrayAwaitTimeout(args.awaitTimeout);

      if (args.action === "open") {
        const result = await ensureSystemTrayOpen(device, awaitTimeoutMs, progress);
        return createJSONToolResponse({
          message: result.skipped
            ? "System tray already open; no swipe needed"
            : "Opened system tray by swiping down from the status bar",
          observation: result.observation,
          success: true,
          skipped: result.skipped,
        });
      }

      if (args.action === "close") {
        const result = await ensureSystemTrayClosed(device, awaitTimeoutMs, progress);
        return createJSONToolResponse({
          message: result.skipped
            ? "System tray already closed; no collapse needed"
            : "Closed system tray (collapsed notification shade)",
          observation: result.observation,
          success: true,
          skipped: result.skipped,
        });
      }

      const notification = args.notification ?? {};
      let appLabel: string | null = null;
      let appMatchTexts: string[] = [];

      if (notification.appId) {
        const listInstalledApps = new ListInstalledApps(device);
        const installedApps = await listInstalledApps.execute();
        if (!installedApps.includes(notification.appId)) {
          throw new ActionableError(`App ${notification.appId} is not installed.`);
        }

        appLabel = await resolveAppLabel(device, notification.appId);
        appMatchTexts = [appLabel, notification.appId].filter(Boolean) as string[];
      }

      if (args.action === "find") {
        const { observation, match } = await waitForNotificationMatch(
          device,
          notification,
          appMatchTexts,
          awaitTimeoutMs,
          progress,
        );

        if (!match) {
          throw new ActionableError(`Notification not found after ${awaitTimeoutMs}ms.`);
        }

        return createJSONToolResponse({
          message: "Found notification in system tray",
          match: match.match.matches,
          observation,
          success: true,
        });
      }

      if (args.action === "tap") {
        let { match } = await waitForNotificationMatch(
          device,
          notification,
          appMatchTexts,
          awaitTimeoutMs,
          progress,
        );

        if (!match) {
          throw new ActionableError(`Notification not found after ${awaitTimeoutMs}ms.`);
        }

        if (isMatchInCollapsedGroup(match)) {
          await expandNotificationGroup(device, match);
          const { timer } = getSystemTrayDependencies();
          await timer.sleep(EXPAND_GROUP_SETTLE_MS);
          const remainingMs = Math.max(0, awaitTimeoutMs - EXPAND_GROUP_SETTLE_MS);
          const reMatch = await waitForNotificationMatch(
            device,
            notification,
            appMatchTexts,
            remainingMs,
            progress,
          );
          if (reMatch.match) {
            match = reMatch.match;
          } else {
            throw new ActionableError(
              "Expanded collapsed notification group but could not re-match the notification. " +
                "The group may have changed after expansion.",
            );
          }
        }

        const tapMatch = resolveNotificationTapElement(match, notification);
        if (!tapMatch) {
          throw new ActionableError(
            "No notification tap target was resolved within the matched notification.",
          );
        }

        await tapElement(device, tapMatch.element);
        const { observeScreenFactory } = getSystemTrayDependencies();
        const observeScreen = observeScreenFactory(device);
        const nextObservation = await observeScreen.execute();

        return createJSONToolResponse({
          message: notification.tapActionLabel
            ? `Tapped notification action "${notification.tapActionLabel}"`
            : "Tapped notification",
          match: match.match.matches,
          tapTarget: {
            text: tapMatch.text,
            matchType: tapMatch.matchType,
            bounds: tapMatch.element.bounds,
          },
          observation: nextObservation,
          success: true,
        });
      }

      if (args.action === "dismiss") {
        const { match } = await waitForNotificationMatch(
          device,
          notification,
          appMatchTexts,
          awaitTimeoutMs,
          progress,
        );

        if (!match) {
          throw new ActionableError(`Notification not found after ${awaitTimeoutMs}ms.`);
        }

        const swipeTarget = resolveNotificationSwipeElement(match, notification, appMatchTexts);
        if (!swipeTarget) {
          throw new ActionableError(
            "No swipeable notification element was resolved within the matched notification.",
          );
        }

        await swipeElement(device, swipeTarget);
        const { observeScreenFactory } = getSystemTrayDependencies();
        const observeScreen = observeScreenFactory(device);
        const nextObservation = await observeScreen.execute();

        return createJSONToolResponse({
          message: "Dismissed notification",
          match: match.match.matches,
          observation: nextObservation,
          success: true,
        });
      }

      if (args.action === "clearAll") {
        let dismissed = 0;
        const { timer } = getSystemTrayDependencies();

        for (let i = 0; i < SYSTEM_TRAY_CLEAR_MAX_ITERATIONS; i++) {
          const { match } = await waitForNotificationMatch(
            device,
            notification,
            appMatchTexts,
            500,
            progress,
          );

          if (!match) {
            break;
          }

          const swipeTarget = resolveNotificationSwipeElement(match, notification, appMatchTexts);
          if (!swipeTarget) {
            break;
          }

          await swipeElement(device, swipeTarget);
          dismissed++;
          await timer.sleep(SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS + 100);
        }

        const { observeScreenFactory } = getSystemTrayDependencies();
        const observeScreen = observeScreenFactory(device);
        const nextObservation = await observeScreen.execute();

        return createJSONToolResponse({
          message:
            dismissed > 0
              ? `Cleared ${dismissed} notification(s) for ${notification.appId}`
              : `No notifications found for ${notification.appId}`,
          dismissedCount: dismissed,
          observation: nextObservation,
          success: true,
        });
      }

      throw new ActionableError(`Unknown systemTray action: ${args.action}`);
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`systemTray failed: ${error}`);
    }
  };

  // Swipe on handler
  const swipeOnHandler = async (
    device: BootedDevice,
    args: SwipeOnArgs,
    progress?: ProgressCallback,
  ): Promise<StructuredToolResponse<SwipeOnToolPayload>> => {
    RecompositionTracker.getInstance().recordInteraction();
    const swipeOn = new SwipeOn(device);
    const resolvedDirection = resolveSwipeDirection({
      direction: args.direction,
      gestureType: args.gestureType,
    });
    const result = await swipeOn.execute(
      {
        container: args.container,
        autoTarget: args.autoTarget ?? true,
        direction: resolvedDirection.direction,
        lookFor: args.lookFor,
        speed: args.speed,
        includeSystemInsets: args.includeSystemInsets ?? false,
        boomerang: args.boomerang,
        apexPause: args.apexPause,
        returnSpeed: args.returnSpeed,
      },
      progress,
    );

    return createStructuredToolResponse({
      message: formatSwipeOnMessage(result, args.direction),
      observation: result.observation,
      ...result,
    });
  };

  // Pinch on handler
  const pinchOnHandler = async (
    device: BootedDevice,
    args: PinchOnArgs,
    progress?: ProgressCallback,
  ) => {
    RecompositionTracker.getInstance().recordInteraction();
    const pinchOn = new PinchOn(device);
    const result = await pinchOn.execute(
      {
        direction: args.direction,
        distanceStart: args.distanceStart,
        distanceEnd: args.distanceEnd,
        scale: args.scale,
        duration: args.duration,
        rotationDegrees: args.rotationDegrees,
        includeSystemInsets: args.includeSystemInsets,
        container: args.container,
        autoTarget: args.autoTarget,
      },
      progress,
    );

    return createJSONToolResponse({
      message: `Pinched ${args.direction}`,
      observation: result.observation,
      ...result,
    });
  };

  // Input text handler
  const inputTextHandler = async (
    device: BootedDevice,
    args: InputTextArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    RecompositionTracker.getInstance().recordInteraction();
    const dismissKeyboard =
      args.dismissKeyboard ?? serverConfig.isDismissKeyboardAfterInputEnabled();
    const mode = device.platform === "android" ? args.mode : undefined;
    const inputText = new InputText(device);
    const result = await inputText.execute(
      args.text,
      args.imeAction,
      dismissKeyboard,
      mode,
      signal,
    );
    return createJSONToolResponse({
      message: `Input text`,
      observation: result.observation,
      ...result,
    });
  };

  // Wake and unlock handler
  const wakeAndUnlockHandler = async (device: BootedDevice, args: WakeAndUnlockArgs) => {
    const iosUnlocker = device.platform === "ios" ? new IosLockScreenUnlocker(device) : undefined;
    const wakeAndUnlock = new WakeAndUnlock(device, undefined, {
      credentialStore: new DeviceLockStore(),
      iosUnlocker,
    });
    const result = await wakeAndUnlock.execute(args.pin);
    const message = result.success
      ? result.wasLocked
        ? "Device unlocked"
        : "Device awake"
      : `Failed to unlock device: ${result.error ?? "unknown error"}`;
    return createJSONToolResponse({ message, ...result });
  };

  // Open link handler
  const openLinkHandler = async (
    device: BootedDevice,
    args: OpenLinkArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    const openUrl = new OpenURL(device);
    const result = await openUrl.execute(args.url);

    // Integrated waitFor (issue #3490 §5): once the URL is opened, poll for the
    // predicate exactly as `observe` does, surfacing the awaited observation and
    // await metadata so callers no longer need a separate observe round-trip.
    const waitOutcome = args.waitFor
      ? await waitForObservation(
          new RealObserveScreen(device),
          { ...args.waitFor, settled: args.settled },
          signal,
          false,
          defaultTimer,
          device.platform,
        )
      : null;

    return createJSONToolResponse(buildOpenLinkPayload(args.url, result, waitOutcome));
  };

  // Shake handler
  const shakeHandler = async (
    device: BootedDevice,
    args: ShakeArgs,
    progress?: ProgressCallback,
  ) => {
    try {
      const shake = new Shake(device);
      const result = await shake.execute(
        {
          duration: args.duration ?? 1000,
          intensity: args.intensity ?? 100,
        },
        progress,
      );

      return createJSONToolResponse({
        message: result.success
          ? `Shook device for ${args.duration ?? 1000}ms with intensity ${args.intensity ?? 100}`
          : `Failed to shake device: ${result.error ?? "unknown error"}`,
        observation: result.observation,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to shake device: ${error}`);
    }
  };

  // IME action handler
  const imeActionHandler = async (
    device: BootedDevice,
    args: ImeActionArgs,
    progress?: ProgressCallback,
  ) => {
    try {
      const imeAction = new ImeAction(device);
      const result = await imeAction.execute(args.action, progress);

      return createJSONToolResponse({
        message: `Executed IME action "${args.action}"`,
        observation: result.observation,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to execute IME action: ${error}`);
    }
  };

  // Keyboard handler
  const keyboardHandler = async (device: BootedDevice, args: KeyboardArgs) => {
    try {
      const keyboard = new Keyboard(device);
      const result = await keyboard.execute(args.action);

      return createJSONToolResponse(result);
    } catch (error) {
      throw new ActionableError(`Failed to execute keyboard ${args.action}: ${error}`);
    }
  };

  // Recent Apps handler
  const recentAppsHandler = async (
    device: BootedDevice,
    args: RecentAppsArgs,
    progress?: ProgressCallback,
  ) => {
    try {
      const recentApps = new RecentApps(device);
      const result = await recentApps.execute(progress);

      return createJSONToolResponse({
        message: formatRecentAppsMessage(result),
        observation: result.observation,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to open recent apps: ${error}`);
    }
  };

  // Home Screen handler
  const homeScreenHandler = async (
    device: BootedDevice,
    args: any,
    progress?: ProgressCallback,
  ) => {
    try {
      const homeScreen = new HomeScreen(device);
      const result = await homeScreen.execute(progress);

      return createJSONToolResponse({
        message: "Pressed home button to return to the home screen",
        observation: result.observation,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to go to home screen: ${error}`);
    }
  };

  // Rotate handler
  const rotateHandler = async (
    device: BootedDevice,
    args: RotateArgs,
    progress?: ProgressCallback,
  ) => {
    try {
      const rotate = new Rotate(device);
      const result = await rotate.execute(args.orientation, progress);

      return createJSONToolResponse({
        message: `Rotated device to ${args.orientation} orientation`,
        observation: result.observation,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to rotate device: ${error}`);
    }
  };

  // Clipboard handler
  const clipboardHandler = async (device: BootedDevice, args: ClipboardArgs) => {
    try {
      const clipboard = new Clipboard(device);
      const result = await clipboard.execute(args.action, args.text);

      let message = formatClipboardMessage(result);

      if (result.method) {
        message += ` (via ${result.method})`;
      }

      return createJSONToolResponse({
        message,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to execute clipboard ${args.action}: ${error}`);
    }
  };

  // Register with the tool registry
  ToolRegistry.registerDeviceAware(
    "clearText",
    "Clear text from focused input",
    clearTextSchema,
    clearTextHandler,
    { defaultEnabled: true, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "selectAllText",
    "Select all text in focused input",
    selectAllTextSchema,
    selectAllTextHandler,
    { defaultEnabled: false, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "pressButton",
    "Press device or navigation button",
    pressButtonSchema,
    pressButtonHandler,
    { defaultEnabled: true, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "systemTray",
    "System tray actions for notifications (open/close/find/tap/dismiss/clearAll)",
    systemTraySchema,
    systemTrayHandler,
    { defaultEnabled: false, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "inputText",
    "Input text. The optional mode field is Android-only and ignored on iOS.",
    inputTextSchema,
    inputTextHandler,
    { defaultEnabled: true },
  );

  ToolRegistry.registerDeviceAware(
    "wakeAndUnlock",
    "Wake a device and unlock its keyguard. Android: swipe lock or secure PIN via `pin`; iOS: wake + swipe-dismiss (pin ignored).",
    wakeAndUnlockSchema,
    wakeAndUnlockHandler,
    { defaultEnabled: true },
  );

  ToolRegistry.registerDeviceAware(
    "openLink",
    "Open URL in browser",
    openLinkSchema,
    openLinkHandler,
    { defaultEnabled: false },
  );

  ToolRegistry.registerDeviceAware(
    "tapOn",
    "Tap an element by text/content-desc, resource-id, or Android test tag; use sibling for adjacent controls.",
    tapOnSchema,
    tapOnHandler,
    { defaultEnabled: true, supportsProgress: true, outputSchema: tapOnResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "tapAny",
    "Tap any clickable element; scope with container or scrollableContainer.",
    tapAnySchema,
    tapAnyHandler,
    { defaultEnabled: true, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "dragAndDrop",
    "Drag and drop element",
    dragAndDropSchema,
    dragAndDropHandler,
    { defaultEnabled: false, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "swipeOn",
    "Swipe/scroll on screen or elements",
    swipeOnSchema,
    swipeOnHandler,
    { defaultEnabled: true, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware("pinchOn", "Pinch to zoom", pinchOnSchema, pinchOnHandler, {
    defaultEnabled: false,
    supportsProgress: true,
  });

  ToolRegistry.registerDeviceAware(
    "shake",
    "Shake device; iOS Simulator only.",
    shakeSchema,
    shakeHandler,
    { defaultEnabled: false, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "imeAction",
    "Perform IME action",
    imeActionSchema,
    imeActionHandler,
    { defaultEnabled: false, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "keyboard",
    "Open, close, or detect the on-screen keyboard",
    keyboardSchema,
    keyboardHandler,
    { defaultEnabled: true },
  );

  ToolRegistry.registerDeviceAware(
    "recentApps",
    "Open recent apps",
    recentAppsSchema,
    recentAppsHandler,
    { defaultEnabled: true, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "homeScreen",
    "Go to home screen",
    homeScreenSchema,
    homeScreenHandler,
    { defaultEnabled: true, supportsProgress: true },
  );

  // Register the new rotate tool
  ToolRegistry.registerDeviceAware(
    "rotate",
    "Rotate device orientation",
    rotateSchema,
    rotateHandler,
    { defaultEnabled: false, supportsProgress: true },
  );

  // Register the clipboard tool
  ToolRegistry.registerDeviceAware(
    "clipboard",
    "Clipboard operations (copy/paste/clear/get)",
    clipboardSchema,
    clipboardHandler,
    { defaultEnabled: false },
  );
}
