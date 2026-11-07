import { z } from "zod/v4";
import { ActionableError, toActionableError } from "../models";
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
  type FocusKeyboardHider,
  type FocusKeyPresser,
  type FocusNavigateOptions,
  type FocusNavigateResult,
} from "../features/action/FocusNavigate";
import { tvosFocusNavigate } from "../features/tvos/TvosFocusNavigate";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { createFocusNavigateObserver } from "../features/action/FocusNavigateObserver";
import {
  pinnedFocusOptions,
  SelectorDpadTargetResolver,
} from "../features/action/DpadTargetResolver";
import { ResolverElementSelector } from "../features/utility/ResolverElementSelector";

const focusNavigateInput = z.object({
  until: z
    .object({
      text: z.string().optional().describe("Text of the element to focus (case-insensitive)"),
      contentDesc: z.string().optional().describe("Content-desc of the element to focus"),
      resourceId: z.string().optional().describe("Resource ID of the element to focus"),
      label: z
        .string()
        .optional()
        .describe("Text or content-desc of the element to focus, resolved as tapOn's text"),
      elementId: z
        .string()
        .optional()
        .describe("Element ID of the element to focus, resolved as tapOn's elementId"),
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
  select: z
    .boolean()
    .optional()
    .describe("Press enter (D-pad select) once the target is focused (default false)"),
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
    // Required, so a spilled response keeps it inline beside success and status.
    selected: z.boolean(),
    message: z.string().optional(),
  })
  .passthrough();

export { createFocusNavigateObserver };

export function createFocusKeyPresser(device: BootedDevice): FocusKeyPresser {
  const input = new InputKey(device, { adbFactory: defaultAdbClientFactory, timer: defaultTimer });
  return {
    press: (key, signal) => input.press(key, undefined, undefined, signal ? { signal } : {}),
  };
}

/**
 * Hides the Android IME with KEYCODE_BACK. FocusNavigate calls it only after a read showed an IME
 * window, so the back press closes the keyboard instead of leaving the screen.
 */
export function createFocusKeyboardHider(device: BootedDevice): FocusKeyboardHider {
  const adb = defaultAdbClientFactory.create(device);
  return {
    hideKeyboard: async (signal) => {
      try {
        await adb.executeCommand("shell input keyevent KEYCODE_BACK", signal ? { signal } : {});
        return { success: true };
      } catch (error) {
        throw toActionableError(error, "Failed to hide the on-screen keyboard with back");
      }
    },
  };
}

/** `label` and `elementId` targets resolve to the element tapOn would tap. */
const targetResolver = new SelectorDpadTargetResolver(new ResolverElementSelector());

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
    createFocusKeyPresser(device),
    defaultTimer,
    createFocusKeyboardHider(device),
  ).execute(options);
}

export const focusNavigateTool = defineDeviceTool({
  name: "focusNavigate",
  description:
    "Move D-pad focus to an element on a focus-driven UI such as Android TV or Apple TV. Observes, and until the focused element matches `until` (text, contentDesc, resourceId, or label/elementId resolved to the element tapOn would tap) presses the D-pad arrow (Siri Remote direction on Apple TV) that moves toward the nearest match, or `direction` when given. When a press leaves focus unchanged, or presses in one direction keep moving focus without getting closer, the other arrows are tried so focus can leave a list or slider that traps it. Returns the path of focused elements and a status: focused, max_steps (default 30) or stuck (every arrow from the focused element was tried; two unchanged presses with `direction`). With `select`, presses enter (select on Apple TV) once focused (`selected` reports whether it did); otherwise activate the result with sendKeys key enter on Android TV, or pressButton select on Apple TV.",
  input: focusNavigateInput,
  handler: async (device, args, _progress, signal) => {
    const result = await runFocusNavigate(device, {
      until: args.until,
      ...(args.direction !== undefined ? { direction: args.direction } : {}),
      ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
      ...(args.settleMs !== undefined ? { settleMs: args.settleMs } : {}),
      ...(args.select !== undefined ? { select: args.select } : {}),
      ...pinnedFocusOptions(args.until, targetResolver),
      ...(signal ? { signal } : {}),
    });
    // `selected` is always reported, so callers never have to infer it from `select`.
    const response = { ...result, selected: result.selected ?? false };
    return withIsErrorOnFailure(createStructuredToolResponse(response), result.success);
  },
  options: {
    ...PLAN_RELEVANT,
    // `select` can navigate, so record the call like tapOn and sendKeys for navigateTo to replay.
    recordsNavigation: true,
    defaultEnabled: false,
    outputSchema: focusNavigateResultSchema,
  },
});
