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
} from "../features/action/FocusNavigate";
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

/** `label` and `elementId` targets resolve to the element tapOn would tap. */
const targetResolver = new SelectorDpadTargetResolver(new ResolverElementSelector());

export const focusNavigateTool = defineDeviceTool({
  name: "focusNavigate",
  description:
    "Move D-pad focus to an element on a focus-driven UI such as Android TV. Observes, and until the focused element matches `until` (text, contentDesc, resourceId, or label/elementId resolved to the element tapOn would tap) presses the D-pad arrow that moves toward the nearest match, or `direction` when given. When a press leaves focus unchanged, or presses in one direction keep moving focus without getting closer, the other arrows are tried so focus can leave a list or slider that traps it. Returns the path of focused elements and a status: focused, max_steps (default 30) or stuck (every arrow from the focused element was tried; two unchanged presses with `direction`). With `select`, presses enter once focused (`selected` reports whether it did); otherwise activate the result with sendKeys key enter.",
  input: focusNavigateInput,
  handler: async (device, args, _progress, signal) => {
    if (device.platform !== "android") {
      throw new ActionableError("focusNavigate is only supported on Android.");
    }
    const navigate = new FocusNavigate(
      createFocusNavigateObserver(new RealObserveScreen(device, defaultAdbClientFactory)),
      createFocusKeyPresser(device),
      defaultTimer,
    );
    const result = await navigate.execute({
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
