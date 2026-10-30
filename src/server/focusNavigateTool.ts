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
  type FocusObserver,
} from "../features/action/FocusNavigate";
import { findFocusedElement } from "../features/observe/HierarchyFocus";
import { DefaultElementParser } from "../features/utility/ElementParser";
import { RealObserveScreen } from "../features/observe/ObserveScreen";

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

function createObserver(device: BootedDevice): FocusObserver {
  const screen = new RealObserveScreen(device, defaultAdbClientFactory);
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
      return {
        focused: result.focusedElement ?? findFocusedElement(result.viewHierarchy, parser),
        elements: parser.flattenViewHierarchy(result.viewHierarchy).map(({ element }) => element),
      };
    },
  };
}

function createKeyPresser(device: BootedDevice): FocusKeyPresser {
  const input = new InputKey(device, { adbFactory: defaultAdbClientFactory, timer: defaultTimer });
  return { press: (key) => input.press(key) };
}

export const focusNavigateTool = defineDeviceTool({
  name: "focusNavigate",
  description:
    "Move D-pad focus to an element on a focus-driven UI such as Android TV. Observes, and until the focused element matches `until` (text, contentDesc or resourceId) presses the D-pad arrow that moves toward the nearest match, or `direction` when given. When a press leaves focus unchanged, the next arrow toward the match is tried. Returns the path of focused elements and a status: focused, max_steps (default 30) or stuck (every arrow toward the match left focus unchanged; two unchanged presses with `direction`). Activate the result with sendKeys key enter.",
  input: focusNavigateInput,
  handler: async (device, args, _progress, signal) => {
    if (device.platform !== "android") {
      throw new ActionableError("focusNavigate is only supported on Android.");
    }
    const navigate = new FocusNavigate(
      createObserver(device),
      createKeyPresser(device),
      defaultTimer,
    );
    const result = await navigate.execute({
      until: args.until,
      ...(args.direction !== undefined ? { direction: args.direction } : {}),
      ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
      ...(args.settleMs !== undefined ? { settleMs: args.settleMs } : {}),
      ...(signal ? { signal } : {}),
    });
    return withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
  },
  options: {
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    outputSchema: focusNavigateResultSchema,
  },
});
