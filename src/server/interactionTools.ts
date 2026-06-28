import { z } from "zod";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { TapOnElement } from "../features/action/TapOnElement";
import { TapAnyElement } from "../features/action/TapAnyElement";
import { InputText } from "../features/action/InputText";
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
} from "../models";
import { ListInstalledApps } from "../features/observe/ListInstalledApps";
import { createJSONToolResponse, createStructuredToolResponse } from "../utils/toolUtils";
import { resolveSwipeDirection } from "../utils/swipeOnUtils";
import { RecompositionTracker } from "../features/performance/RecompositionTracker";
import { addDeviceTargetingToSchema, platformSchema } from "./toolSchemaHelpers";
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
export type {
  SystemTrayObserver,
  SystemTrayAdb,
  SystemTrayDependencies,
};

export {
  setSystemTrayDependencies,
  resetSystemTrayDependencies,
  waitForNotificationMatch,
};

// ============================================================================
// Schema Definitions
// ============================================================================

export const shakeSchema = addDeviceTargetingToSchema(z.object({
  duration: z.number().optional().describe("Shake duration in ms (default: 1000). On iOS Simulator this contributes to the runner timeout budget."),
  intensity: z.number().optional().describe("Shake acceleration intensity (default: 100). Ignored on iOS Simulator because XCTest shake has no intensity parameter."),
  platform: platformSchema
}));

export const keyboardSchema = addDeviceTargetingToSchema(z.object({
  action: z.enum(["open", "close", "detect"]).describe("Keyboard action"),
  platform: platformSchema
}));

const tapOnSelectorSchema = z.union([
  z.object({ elementId: z.string().min(1).describe("Element resource-id (e.g. \"com.app:id/btn_login\"). Only use for resource-id values.") }).strict(),
  z.object({ text: z.string().min(1).describe("Element text, content-desc, or placeholder value from observe output.") }).strict()
]).describe("Element to tap. Provide exactly one of elementId or text.");

export const tapOnSchema = addDeviceTargetingToSchema(z.object({
  selector: tapOnSelectorSchema,
  sibling: z.boolean().optional().describe(
    "When true, tap a clickable sibling of the matched element instead of the element itself. " +
    "Useful for tapping checkboxes, icons, or buttons adjacent to a text label."
  ),
  container: elementContainerSchema.optional().describe(
    "Container selector object to scope search. Provide { \"elementId\": \"<id>\" } or { \"text\": \"<text>\" }."
  ),
  action: z.enum(["tap", "doubleTap", "longPress", "focus"]).default("tap").describe("Action type (default: tap)"),
  selectionStrategy: elementSelectionStrategySchema.optional().describe(
    "Element selection strategy when multiple matches are found (default: first)"
  ),
  duration: z.number().optional().describe("Long press duration (ms)"),
  searchUntil: z.object({
    duration: z.number().min(100).max(12000).optional().describe("Polling duration (ms, default: 500)"),
  }).optional().describe("Poll for element before tapping"),
  preTapStability: z.boolean().optional().describe(
    "When true, refresh the accessibility hierarchy before tapping and require consecutive re-finds with " +
    "stable bounds before dispatching the gesture. Prevents tapping stale coordinates when the UI is still " +
    "settling (loading overlays, list refreshes, keyboard). Recommended for search result lists and dynamic content."
  ),
  retryIfNoChange: z.boolean().optional().describe(
    "When true, compare the view hierarchy before and after the tap. If unchanged (ghost tap detected), " +
    "retry the tap once after a short delay. Recommended for taps that should cause obvious UI changes " +
    "like navigation or screen transitions."
  ),
  ensureTap: z.boolean().optional().describe(
    "Convenience flag that enables both preTapStability and retryIfNoChange. " +
    "Use on taps in dynamic UI where you want both stable bounds before tapping " +
    "and ghost-tap detection after."
  ),
  platform: platformSchema
}).strict());

const tapOnResultSchema = z.object({
  success: z.boolean(),
  action: z.string().optional(),
  message: z.string().optional(),
  error: z.string().optional()
}).passthrough();

export const tapAnySchema = addDeviceTargetingToSchema(z.object({
  container: elementContainerSchema.optional().describe(
    "Container selector object to scope search. Provide { \"elementId\": \"<id>\" } or { \"text\": \"<text>\" }."
  ),
  selectionStrategy: elementSelectionStrategySchema.optional().describe(
    "Element selection strategy: 'first' (default) or 'random'"
  ),
  scrollableContainer: z.boolean().optional().describe(
    "Only search within scrollable containers (lists/RecyclerViews). " +
    "Use this to avoid tapping search bars or other clickable UI elements " +
    "when you want the first list item."
  ),
  action: z.enum(["tap", "doubleTap", "longPress"]).default("tap").describe("Action type (default: tap)"),
  duration: z.number().optional().describe("Long press duration (ms)"),
  searchUntil: z.object({
    duration: z.number().min(100).max(12000).optional().describe("Polling duration (ms, default: 500)"),
  }).optional().describe("Poll for clickable element before tapping"),
  platform: platformSchema
}).strict());

const dragAndDropSelectorSchema = (label: "Source" | "Target") =>
  createElementIdTextSelectorSchema({
    elementId: `${label} ID`,
    text: `${label} text`
  }).describe(`${label} element`);

const swipeOnLookForSchema = createElementIdTextSelectorSchema({
  elementId: "ID of the element to look for",
  text: "Text to look for"
});

export const dragAndDropSchema = addDeviceTargetingToSchema(z.object({
  source: dragAndDropSelectorSchema("Source"),
  target: dragAndDropSelectorSchema("Target"),
  pressDurationMs: z.number().min(600).max(3000).optional().describe(
    "Press duration ms (min: 600, max: 3000, default: 600)"
  ),
  dragDurationMs: z.number().min(300).max(1000).optional().describe(
    "Drag duration ms (min: 300, max: 1000, default: 300)"
  ),
  holdDurationMs: z.number().min(100).max(3000).optional().describe(
    "Hold duration ms (min: 100, max: 3000, default: 100)"
  ),
  platform: platformSchema
}));

export const swipeOnSchema = addDeviceTargetingToSchema(z.object({
  includeSystemInsets: z.boolean().optional().describe("Use full screen including status/nav bars"),
  container: elementContainerSchema.optional().describe(
    "Container selector object to scope search. Provide { \"elementId\": \"<id>\" } or { \"text\": \"<text>\" }."
  ),
  autoTarget: z.boolean().optional().describe("Auto-target scrollable containers (default: true)"),
  direction: z.enum(["up", "down", "left", "right"]).describe("Swipe/scroll direction"),
  gestureType: z.enum(["swipeFingerTowardsDirection", "scrollTowardsDirection"]).optional()
    .describe("swipeFingerTowardsDirection: finger moves in direction (e.g., 'up' = finger up = content scrolls down). scrollTowardsDirection: content moves in direction (e.g., 'up' = content up = see content below). Default: scrollTowardsDirection."),
  lookFor: swipeOnLookForSchema.optional().describe("Element to look for during swipe"),
  boomerang: z.boolean().optional().describe("Return to start position after swipe apex"),
  apexPause: z.number().min(0).max(3000).optional().describe("Pause duration at swipe apex in ms (0-3000)"),
  returnSpeed: z.number().min(0.1).max(3.0).optional().describe("Speed multiplier for return swipe (0.1-3.0)"),
  speed: z.enum(["slow", "normal", "fast"]).optional().describe("Swipe speed preset"),
  platform: platformSchema
}));

export const pinchOnSchema = addDeviceTargetingToSchema(z.object({
  direction: z.enum(["in", "out"]).describe("Pinch direction"),
  distanceStart: z.number().optional().describe("Initial finger distance (px, default: 400)"),
  distanceEnd: z.number().optional().describe("Final finger distance (px, default: 100)"),
  scale: z.number().optional().describe("Scale factor (overrides distances)"),
  duration: z.number().optional().describe("Gesture duration (ms)"),
  rotationDegrees: z.number().optional().describe("Rotation during pinch (degrees)"),
  includeSystemInsets: z.boolean().optional().describe("Use full screen including status/nav bars"),
  container: elementContainerSchema.optional().describe(
    "Container selector object to scope search. Provide { \"elementId\": \"<id>\" } or { \"text\": \"<text>\" }."
  ),
  autoTarget: z.boolean().optional().describe("Auto-target pinchable containers"),
  platform: platformSchema
}));

export const clearTextSchema = addDeviceTargetingToSchema(z.object({
  platform: platformSchema
}));

export const selectAllTextSchema = addDeviceTargetingToSchema(z.object({
  platform: platformSchema
}));

export const pressButtonSchema = addDeviceTargetingToSchema(z.object({
  button: z.enum(["home", "back", "menu", "power", "volume_up", "volume_down", "recent"])
    .describe("Button to press"),
  platform: platformSchema
}));

const systemTrayNotificationSchema = z.object({
  title: z.string().optional().describe("Notification title to match"),
  body: z.string().optional().describe("Notification body to match"),
  appId: z.string().optional().describe("App package ID to match"),
  tapActionLabel: z.string().optional().describe("Action button label to tap (for 'tap' action)")
});

const systemTraySchemaBase = z.object({
  action: z.enum(["open", "close", "find", "tap", "dismiss", "clearAll"]).describe(
    "Action: open=expand tray, close=collapse tray/shade, find=search for notification, tap=tap notification, dismiss=swipe away, clearAll=dismiss all for app"
  ),
  notification: systemTrayNotificationSchema.optional().describe("Notification criteria to match"),
  awaitTimeout: z.number().optional().describe("Timeout in ms to wait for notification (default: 5000)"),
  platform: platformSchema
});

export const systemTraySchema = addDeviceTargetingToSchema(systemTraySchemaBase).superRefine((value, ctx) => {
  const notification = value.notification ?? {};

  if (value.action === "open" || value.action === "close") {
    return;
  }

  const hasCriteria = notification.title || notification.body || notification.appId;
  if (!hasCriteria) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.action} action requires at least one notification criteria (title, body, or appId)`
    });
  }

  if (value.action === "clearAll" && !notification.appId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "clearAll action requires notification.appId"
    });
  }

  if (notification.tapActionLabel && value.action !== "tap") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "notification.tapActionLabel is only valid for tap action"
    });
  }
});

export const stopAppSchema = addDeviceTargetingToSchema(z.object({
  appId: z.string().describe("App package ID"),
  platform: platformSchema
}));

export const clearStateSchema = addDeviceTargetingToSchema(z.object({
  appId: z.string().describe("App package ID"),
  clearKeychain: z.boolean().optional().describe("Clear iOS keychain"),
  platform: platformSchema
}));

export const inputTextSchema = addDeviceTargetingToSchema(z.object({
  text: z.string().min(1).describe("Text to input"),
  mode: z.enum(["a11y", "eventLast", "eventAll"]).optional()
    .describe("(Android only; ignored on iOS) Text input mode. a11y (default) sets text directly. eventLast sets text with a11y up to the last printable non-whitespace ASCII character, sends that character as a real key event, then restores any suffix with a11y. eventAll clears the field with a11y, sends key events for mappable ASCII characters, and uses a11y for Unicode/emoji runs. Search fields that use autocomplete should probably try eventLast; otherwise accept the default."),
  imeAction: z.enum(["done", "next", "search", "send", "go", "previous"]).optional()
    .describe("IME action after input"),
  dismissKeyboard: z.boolean().optional()
    .describe("(Android only) Dismiss soft keyboard after input (default: false). Ignored on iOS."),
  platform: platformSchema
}));

export const openLinkSchema = addDeviceTargetingToSchema(z.object({
  url: z.string().describe("URL to open"),
  platform: platformSchema
}));

export const imeActionSchema = addDeviceTargetingToSchema(z.object({
  action: z.enum(["done", "next", "search", "send", "go", "previous"]).describe("IME action"),
  platform: platformSchema
}));

export const recentAppsSchema = addDeviceTargetingToSchema(z.object({
  platform: platformSchema
}));

export const homeScreenSchema = addDeviceTargetingToSchema(z.object({
  platform: platformSchema
}));

export const rotateSchema = addDeviceTargetingToSchema(z.object({
  orientation: z.enum(["portrait", "landscape"]).describe("Orientation"),
  platform: platformSchema
}));

const clipboardTextRequiredMessage = "text is required when action is copy";
const optionalClipboardTextSchema = z.string().min(1).optional().describe("Text to copy (required for 'copy' action)");
const clipboardPlatformSchema = {
  platform: platformSchema,
};

export const clipboardSchema = z.discriminatedUnion("action", [
  addDeviceTargetingToSchema(z.object({
    action: z.literal("copy").describe("Clipboard action: copy=set clipboard, paste=paste into focused field, clear=clear clipboard, get=get clipboard content"),
    text: z.string({ error: clipboardTextRequiredMessage })
      .min(1, clipboardTextRequiredMessage)
      .describe("Text to copy (required for 'copy' action)"),
    ...clipboardPlatformSchema,
  })),
  addDeviceTargetingToSchema(z.object({
    action: z.literal("paste").describe("Clipboard action: copy=set clipboard, paste=paste into focused field, clear=clear clipboard, get=get clipboard content"),
    text: optionalClipboardTextSchema,
    ...clipboardPlatformSchema,
  })),
  addDeviceTargetingToSchema(z.object({
    action: z.literal("clear").describe("Clipboard action: copy=set clipboard, paste=paste into focused field, clear=clear clipboard, get=get clipboard content"),
    text: optionalClipboardTextSchema,
    ...clipboardPlatformSchema,
  })),
  addDeviceTargetingToSchema(z.object({
    action: z.literal("get").describe("Clipboard action: copy=set clipboard, paste=paste into focused field, clear=clear clipboard, get=get clipboard content"),
    text: optionalClipboardTextSchema,
    ...clipboardPlatformSchema,
  }))
]);

// ============================================================================
// Tool Registration
// ============================================================================

export function registerInteractionTools() {
  // Tap on handler
  const tapOnHandler = async (device: BootedDevice, args: TapOnArgs, progress?: ProgressCallback) => {
    RecompositionTracker.getInstance().recordInteraction();
    const tapOnTextCommand = new TapOnElement(device);
    const result = await tapOnTextCommand.execute({
      container: args.container,
      text: args.selector.text,
      elementId: args.selector.elementId,
      sibling: args.sibling,
      selectionStrategy: args.selectionStrategy,
      action: args.action,
      duration: args.duration,
      searchUntil: args.searchUntil,
      preTapStability: args.preTapStability,
      retryIfNoChange: args.retryIfNoChange,
      ensureTap: args.ensureTap,
    }, progress);

    const searchStats = result.searchUntil;
    const freshness = result.observation?.freshness;
    const hasFreshnessTimestamp = typeof freshness?.requestedAfter === "number"
      && typeof freshness?.actualTimestamp === "number";
    const hasConfirmedFreshObservation = hasFreshnessTimestamp
      && freshness.actualTimestamp >= freshness.requestedAfter;
    const shouldIncludeSearchSummary = Boolean(searchStats)
      && (
        searchStats.requestCount > 0
        || searchStats.changeCount > 0
        || (Boolean(args.searchUntil) && hasConfirmedFreshObservation)
      );
    const searchSummary = shouldIncludeSearchSummary && searchStats
      ? `${searchStats.changeCount} view hierarchy changes over ${searchStats.requestCount} requests within ${searchStats.durationMs}ms`
      : undefined;

    return createStructuredToolResponse({
      message: searchSummary ? `Tapped on element (${searchSummary})` : "Tapped on element",
      observation: result.observation,
      ...result
    });
  };

  // TapAny handler
  const tapAnyHandler = async (device: BootedDevice, args: TapAnyArgs, progress?: ProgressCallback) => {
    RecompositionTracker.getInstance().recordInteraction();
    const tapAnyCommand = new TapAnyElement(device);
    const result = await tapAnyCommand.execute({
      container: args.container,
      selectionStrategy: args.selectionStrategy,
      scrollableContainer: args.scrollableContainer,
      action: args.action,
      duration: args.duration,
      searchUntil: args.searchUntil,
    }, progress);

    const searchStats = result.searchUntil;
    const shouldIncludeSearchSummary = Boolean(searchStats) && (searchStats!.requestCount > 0 || searchStats!.changeCount > 0);
    const searchSummary = shouldIncludeSearchSummary && searchStats
      ? `${searchStats.changeCount} view hierarchy changes over ${searchStats.requestCount} requests within ${searchStats.durationMs}ms`
      : undefined;

    return createStructuredToolResponse({
      message: searchSummary ? `Tapped clickable element (${searchSummary})` : "Tapped clickable element",
      observation: result.observation,
      ...result
    });
  };

  // Drag and drop handler
  const dragAndDropHandler = async (device: BootedDevice, args: DragAndDropArgs, progress?: ProgressCallback) => {
    RecompositionTracker.getInstance().recordInteraction();
    const dragAndDrop = new DragAndDrop(device);
    const result = await dragAndDrop.execute({
      source: args.source,
      target: args.target,
      pressDurationMs: args.pressDurationMs,
      dragDurationMs: args.dragDurationMs,
      holdDurationMs: args.holdDurationMs
    }, progress);

    return createJSONToolResponse({
      message: "Dragged element to target",
      observation: result.observation,
      ...result
    });
  };

  // Clear text handler
  const clearTextHandler = async (device: BootedDevice, args: ClearTextArgs, progress?: ProgressCallback) => {
    try {
      const clearText = new ClearText(device);
      const result = await clearText.execute(progress);

      return createJSONToolResponse({
        message: "Cleared text from input field",
        observation: result.observation,
        ...result
      });
    } catch (error) {
      throw new ActionableError(`Failed to clear text: ${error}`);
    }
  };

  // Select all text handler
  const selectAllTextHandler = async (device: BootedDevice, args: SelectAllTextArgs, progress?: ProgressCallback) => {
    try {
      const selectAllText = new SelectAllText(device);
      const result = await selectAllText.execute(progress);

      return createJSONToolResponse({
        message: "Selected all text in focused input field",
        observation: result.observation,
        ...result
      });
    } catch (error) {
      throw new ActionableError(`Failed to select all text: ${error}`);
    }
  };

  // Press button handler
  const pressButtonHandler = async (device: BootedDevice, args: PressButtonArgs, progress?: ProgressCallback) => {
    RecompositionTracker.getInstance().recordInteraction();
    try {
      const pressButton = new PressButton(device);
      const result = await pressButton.execute(args.button, progress);

      return createJSONToolResponse({
        message: `Pressed button ${args.button}`,
        observation: result.observation,
        ...result
      });
    } catch (error) {
      throw new ActionableError(`Failed to press button: ${error}`);
    }
  };

  // System tray handler
  const systemTrayHandler = async (device: BootedDevice, args: SystemTrayArgs, progress?: ProgressCallback) => {
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
          skipped: result.skipped
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
          skipped: result.skipped
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
          progress
        );

        if (!match) {
          throw new ActionableError(`Notification not found after ${awaitTimeoutMs}ms.`);
        }

        return createJSONToolResponse({
          message: "Found notification in system tray",
          match: match.match.matches,
          observation,
          success: true
        });
      }

      if (args.action === "tap") {
        let { match } = await waitForNotificationMatch(
          device,
          notification,
          appMatchTexts,
          awaitTimeoutMs,
          progress
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
            progress
          );
          if (reMatch.match) {
            match = reMatch.match;
          } else {
            throw new ActionableError(
              "Expanded collapsed notification group but could not re-match the notification. " +
              "The group may have changed after expansion."
            );
          }
        }

        const tapMatch = resolveNotificationTapElement(match, notification);
        if (!tapMatch) {
          throw new ActionableError("No notification tap target was resolved within the matched notification.");
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
            bounds: tapMatch.element.bounds
          },
          observation: nextObservation,
          success: true
        });
      }

      if (args.action === "dismiss") {
        const { match } = await waitForNotificationMatch(
          device,
          notification,
          appMatchTexts,
          awaitTimeoutMs,
          progress
        );

        if (!match) {
          throw new ActionableError(`Notification not found after ${awaitTimeoutMs}ms.`);
        }

        const swipeTarget = resolveNotificationSwipeElement(match, notification, appMatchTexts);
        if (!swipeTarget) {
          throw new ActionableError("No swipeable notification element was resolved within the matched notification.");
        }

        await swipeElement(device, swipeTarget);
        const { observeScreenFactory } = getSystemTrayDependencies();
        const observeScreen = observeScreenFactory(device);
        const nextObservation = await observeScreen.execute();

        return createJSONToolResponse({
          message: "Dismissed notification",
          match: match.match.matches,
          observation: nextObservation,
          success: true
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
            progress
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
          message: dismissed > 0
            ? `Cleared ${dismissed} notification(s) for ${notification.appId}`
            : `No notifications found for ${notification.appId}`,
          dismissedCount: dismissed,
          observation: nextObservation,
          success: true
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
  const swipeOnHandler = async (device: BootedDevice, args: SwipeOnArgs, progress?: ProgressCallback) => {
    RecompositionTracker.getInstance().recordInteraction();
    const swipeOn = new SwipeOn(device);
    const resolvedDirection = resolveSwipeDirection({ direction: args.direction, gestureType: args.gestureType });
    const result = await swipeOn.execute({
      container: args.container,
      autoTarget: args.autoTarget ?? true,
      direction: resolvedDirection.direction,
      lookFor: args.lookFor,
      speed: args.speed,
      includeSystemInsets: args.includeSystemInsets ?? false,
      boomerang: args.boomerang,
      apexPause: args.apexPause,
      returnSpeed: args.returnSpeed
    }, progress);

    return createStructuredToolResponse({
      message: result.found
        ? `Swiped ${args.direction} and found element after ${result.scrollIterations ?? 1} swipe(s)`
        : `Swiped ${args.direction}`,
      observation: result.observation,
      ...result
    });
  };

  // Pinch on handler
  const pinchOnHandler = async (device: BootedDevice, args: PinchOnArgs, progress?: ProgressCallback) => {
    RecompositionTracker.getInstance().recordInteraction();
    const pinchOn = new PinchOn(device);
    const result = await pinchOn.execute({
      direction: args.direction,
      distanceStart: args.distanceStart,
      distanceEnd: args.distanceEnd,
      scale: args.scale,
      duration: args.duration,
      rotationDegrees: args.rotationDegrees,
      includeSystemInsets: args.includeSystemInsets,
      container: args.container,
      autoTarget: args.autoTarget
    }, progress);

    return createJSONToolResponse({
      message: `Pinched ${args.direction}`,
      observation: result.observation,
      ...result
    });
  };

  // Input text handler
  const inputTextHandler = async (device: BootedDevice, args: InputTextArgs) => {
    RecompositionTracker.getInstance().recordInteraction();
    const dismissKeyboard = args.dismissKeyboard ?? serverConfig.isDismissKeyboardAfterInputEnabled();
    const mode = device.platform === "android" ? args.mode : undefined;
    const inputText = new InputText(device);
    const result = await inputText.execute(args.text, args.imeAction, dismissKeyboard, mode);
    return createJSONToolResponse({
      message: `Input text`,
      observation: result.observation,
      ...result
    });
  };

  // Open link handler
  const openLinkHandler = async (device: BootedDevice, args: OpenLinkArgs) => {
    const openUrl = new OpenURL(device);
    const result = await openUrl.execute(args.url);

    return createJSONToolResponse({
      message: `Opened link ${args.url}`,
      observation: result.observation,
      ...result
    });
  };

  // Shake handler
  const shakeHandler = async (device: BootedDevice, args: ShakeArgs, progress?: ProgressCallback) => {
    try {
      const shake = new Shake(device);
      const result = await shake.execute({
        duration: args.duration ?? 1000,
        intensity: args.intensity ?? 100
      }, progress);

      return createJSONToolResponse({
        message: result.success
          ? `Shook device for ${args.duration ?? 1000}ms with intensity ${args.intensity ?? 100}`
          : `Failed to shake device: ${result.error ?? "unknown error"}`,
        observation: result.observation,
        ...result
      });
    } catch (error) {
      throw new ActionableError(`Failed to shake device: ${error}`);
    }
  };

  // IME action handler
  const imeActionHandler = async (device: BootedDevice, args: ImeActionArgs, progress?: ProgressCallback) => {
    try {
      const imeAction = new ImeAction(device);
      const result = await imeAction.execute(args.action, progress);

      return createJSONToolResponse({
        message: `Executed IME action "${args.action}"`,
        observation: result.observation,
        ...result
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
  const recentAppsHandler = async (device: BootedDevice, args: RecentAppsArgs, progress?: ProgressCallback) => {
    try {
      const recentApps = new RecentApps(device);
      const result = await recentApps.execute(progress);

      return createJSONToolResponse({
        message: "Opened recent apps",
        observation: result.observation,
        ...result
      });
    } catch (error) {
      throw new ActionableError(`Failed to open recent apps: ${error}`);
    }
  };

  // Home Screen handler
  const homeScreenHandler = async (device: BootedDevice, args: any, progress?: ProgressCallback) => {
    try {
      const homeScreen = new HomeScreen(device);
      const result = await homeScreen.execute(progress);

      return createJSONToolResponse({
        message: "Pressed home button to return to the home screen",
        observation: result.observation,
        ...result
      });
    } catch (error) {
      throw new ActionableError(`Failed to go to home screen: ${error}`);
    }
  };

  // Rotate handler
  const rotateHandler = async (device: BootedDevice, args: RotateArgs, progress?: ProgressCallback) => {
    try {
      const rotate = new Rotate(device);
      const result = await rotate.execute(args.orientation, progress);

      return createJSONToolResponse({
        message: `Rotated device to ${args.orientation} orientation`,
        observation: result.observation,
        ...result
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

      // Build descriptive message based on action
      let message = "";
      switch (args.action) {
        case "copy":
          message = `Copied text to clipboard`;
          break;
        case "paste":
          message = `Pasted clipboard content into focused field`;
          break;
        case "clear":
          message = `Cleared clipboard`;
          break;
        case "get":
          message = result.text
            ? `Retrieved clipboard content: "${result.text.substring(0, 50)}${result.text.length > 50 ? "..." : ""}"`
            : `Retrieved empty clipboard`;
          break;
      }

      if (result.method) {
        message += ` (via ${result.method})`;
      }

      return createJSONToolResponse({
        message,
        ...result
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
    true // Supports progress notifications
  );

  ToolRegistry.registerDeviceAware(
    "selectAllText",
    "Select all text in focused input",
    selectAllTextSchema,
    selectAllTextHandler,
    true // Supports progress notifications
  );

  ToolRegistry.registerDeviceAware(
    "pressButton",
    "Press device or navigation button",
    pressButtonSchema,
    pressButtonHandler,
    true // Supports progress notifications
  );

  ToolRegistry.registerDeviceAware(
    "systemTray",
    "System tray actions for notifications (open/close/find/tap/dismiss/clearAll)",
    systemTraySchema,
    systemTrayHandler,
    true // Supports progress notifications
  );

  ToolRegistry.registerDeviceAware(
    "inputText",
    "Input text. The optional mode field is Android-only and ignored on iOS.",
    inputTextSchema,
    inputTextHandler,
    false // Does not support progress notifications
  );

  ToolRegistry.registerDeviceAware(
    "openLink",
    "Open URL in browser",
    openLinkSchema,
    openLinkHandler,
    false // Does not support progress notifications
  );

  ToolRegistry.registerDeviceAware(
    "tapOn",
    "Tap a specific UI element identified by text or resource-id.\n" +
    "Provide a selector: { \"text\": \"Login\" } or { \"elementId\": \"com.app:id/btn\" }.\n" +
    "Set sibling: true to tap a clickable sibling adjacent to the matched element (e.g., a checkbox next to a label).\n" +
    "content-desc values from observe should be passed as text, not elementId.",
    tapOnSchema,
    tapOnHandler,
    true,
    false,
    { outputSchema: tapOnResultSchema }
  );

  ToolRegistry.registerDeviceAware(
    "tapAny",
    "Tap any clickable element without knowing its text or ID. " +
    "Good for tapping the first list item. Use container to scope, " +
    "selectionStrategy to pick 'first' (default) or 'random', and " +
    "scrollableContainer: true to limit to list/RecyclerView items.",
    tapAnySchema,
    tapAnyHandler,
    true
  );

  ToolRegistry.registerDeviceAware(
    "dragAndDrop",
    "Drag and drop element",
    dragAndDropSchema,
    dragAndDropHandler,
    true // Supports progress notifications
  );

  ToolRegistry.registerDeviceAware(
    "swipeOn",
    "Swipe/scroll on screen or elements",
    swipeOnSchema,
    swipeOnHandler,
    true // Supports progress notifications
  );

  ToolRegistry.registerDeviceAware(
    "pinchOn",
    "Pinch to zoom",
    pinchOnSchema,
    pinchOnHandler,
    true // Supports progress notifications
  );

  ToolRegistry.registerDeviceAware(
    "shake",
    "Shake device. iOS support is Simulator-only; physical iOS devices are not supported by XCTest.",
    shakeSchema,
    shakeHandler,
    true // Supports progress notifications
  );

  ToolRegistry.registerDeviceAware(
    "imeAction",
    "Perform IME action",
    imeActionSchema,
    imeActionHandler,
    true // Supports progress notifications
  );

  ToolRegistry.registerDeviceAware(
    "keyboard",
    "Open, close, or detect the on-screen keyboard",
    keyboardSchema,
    keyboardHandler,
    false // Does not support progress notifications
  );

  ToolRegistry.registerDeviceAware(
    "recentApps",
    "Open recent apps",
    recentAppsSchema,
    recentAppsHandler,
    true // Supports progress notifications
  );

  ToolRegistry.registerDeviceAware(
    "homeScreen",
    "Go to home screen",
    homeScreenSchema,
    homeScreenHandler,
    true // Supports progress notifications
  );

  // Register the new rotate tool
  ToolRegistry.registerDeviceAware(
    "rotate",
    "Rotate device orientation",
    rotateSchema,
    rotateHandler,
    true // Supports progress notifications
  );

  // Register the clipboard tool
  ToolRegistry.registerDeviceAware(
    "clipboard",
    "Clipboard operations (copy/paste/clear/get)",
    clipboardSchema,
    clipboardHandler,
    false // Does not support progress notifications
  );
}
