import { z } from "zod/v4";
import { ActionableError } from "../models";
import type { BootedDevice } from "../models";
import { defineDeviceTool } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultTimer } from "../utils/SystemTimer";
import { InputKey } from "../features/action/InputKey";
import {
  FOCUS_NAVIGATE_DEFAULT_MAX_STEPS,
  FOCUS_NAVIGATE_DEFAULT_SETTLE_MS,
  FOCUS_NAVIGATE_DIRECTIONS,
  FOCUS_NAVIGATE_MAX_SETTLE_MS,
  FOCUS_NAVIGATE_MAX_STEPS_LIMIT,
  FOCUS_NAVIGATE_STATUSES,
  FocusNavigate,
  type FocusKeyPresser,
  type FocusNavigateOptions,
  type FocusNavigateResult,
  type FocusObserver,
} from "../features/action/FocusNavigate";
import { tvosFocusNavigate } from "../features/tvos/TvosFocusNavigate";
import { findFocusedElement } from "../features/observe/HierarchyFocus";
import { hasOwnPrototype, scopeHierarchyToLayer } from "../features/observe/hierarchyLayer";
import { DefaultElementParser } from "../features/utility/ElementParser";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import type { ObserveScreen } from "../features/observe/interfaces/ObserveScreen";

const focusNavigateInput = z.object({
  until: z
    .object({
      text: z.string().optional().describe("Text of the element to focus (case-insensitive)"),
      contentDesc: z.string().optional().describe("Content-desc of the element to focus"),
      resourceId: z.string().optional().describe("Resource ID of the element to focus"),
    })
    .strict()
    .describe("The element focus should land on; every field given must match"),
  direction: z
    .enum(FOCUS_NAVIGATE_DIRECTIONS)
    .optional()
    .describe("Press this D-pad direction every step instead of steering toward the target"),
  maxSteps: z
    .number()
    .int()
    .min(1)
    .max(FOCUS_NAVIGATE_MAX_STEPS_LIMIT)
    .optional()
    .describe(`Maximum D-pad presses (default ${FOCUS_NAVIGATE_DEFAULT_MAX_STEPS})`),
  settleMs: z
    .number()
    .int()
    .min(0)
    .max(FOCUS_NAVIGATE_MAX_SETTLE_MS)
    .optional()
    .describe(
      `Wait after each press before observing (default ${FOCUS_NAVIGATE_DEFAULT_SETTLE_MS})`,
    ),
});

export const focusNavigateResultSchema = z
  .object({
    success: z.boolean(),
    status: z.enum(FOCUS_NAVIGATE_STATUSES),
    steps: z.number(),
    path: z.array(z.record(z.string(), z.unknown())),
    focusedElement: z.record(z.string(), z.unknown()).optional(),
    message: z.string().optional(),
  })
  .passthrough();

const parser = new DefaultElementParser();

export function createFocusNavigateObserver(screen: Pick<ObserveScreen, "execute">): FocusObserver {
  return {
    read: async (signal) => {
      const result = await screen.execute({
        hierarchyOnly: true,
        skipScreenshot: true,
        skipCache: true,
        freshness: "fresh",
        signal,
      });
      if (!result.viewHierarchy) {
        throw new ActionableError(result.error ?? "The hierarchy read returned no view hierarchy");
      }
      let hierarchy = result.viewHierarchy;
      let focused = result.focusedElement ?? findFocusedElement(hierarchy, parser);
      if (hasOwnPrototype(hierarchy)) {
        // App nodes can retain focus behind the overlay; prefer the prototype's own focus.
        const prototype = scopeHierarchyToLayer(hierarchy, "prototype");
        const prototypeFocus = findFocusedElement(prototype, parser);
        hierarchy = prototypeFocus ? prototype : scopeHierarchyToLayer(hierarchy, "app");
        focused = prototypeFocus ?? findFocusedElement(hierarchy, parser);
      }
      return {
        focused,
        elements: parser.flattenViewHierarchy(hierarchy).map(({ element }) => element),
      };
    },
  };
}

function createKeyPresser(device: BootedDevice): FocusKeyPresser {
  const input = new InputKey(device, { adbFactory: defaultAdbClientFactory, timer: defaultTimer });
  return { press: (key) => input.press(key) };
}

function runFocusNavigate(
  device: BootedDevice,
  options: FocusNavigateOptions,
): Promise<FocusNavigateResult> {
  if (device.platform === "tvos") {
    return tvosFocusNavigate(device.deviceId, options, defaultTimer);
  }
  if (device.platform !== "android") {
    throw new ActionableError("focusNavigate is only supported on Android and tvOS.");
  }
  return new FocusNavigate(
    createFocusNavigateObserver(new RealObserveScreen(device, defaultAdbClientFactory)),
    createKeyPresser(device),
    defaultTimer,
  ).execute(options);
}

export const focusNavigateTool = defineDeviceTool({
  name: "focusNavigate",
  description:
    "Move D-pad focus to an element on a focus-driven UI such as Android TV or Apple TV. Observes, and until the focused element matches `until` (text, contentDesc or resourceId) presses the D-pad arrow (Siri Remote direction on Apple TV) that moves toward the nearest match, or `direction` when given. When a press leaves focus unchanged, the next arrow toward the match is tried. Returns the path of focused elements and a status: focused, max_steps (default 30) or stuck (every arrow toward the match left focus unchanged; two unchanged presses with `direction`). Activate the result with sendKeys key enter on Android TV, or pressButton select on Apple TV.",
  input: focusNavigateInput,
  handler: async (device, args, _progress, signal) => {
    const options = {
      until: args.until,
      ...(args.direction !== undefined ? { direction: args.direction } : {}),
      ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
      ...(args.settleMs !== undefined ? { settleMs: args.settleMs } : {}),
      ...(signal ? { signal } : {}),
    };
    const result = await runFocusNavigate(device, options);
    return withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
  },
  options: {
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    outputSchema: focusNavigateResultSchema,
  },
});
