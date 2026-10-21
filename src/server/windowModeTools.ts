import { z } from "zod/v4";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { defineDeviceTool } from "./defineTool";
import { windowModeResultSchema } from "./windowModeToolOutputSchemas";
import { ActionableError, type BootedDevice } from "../models";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultTimer } from "../utils/SystemTimer";
import { GetBackStack } from "../features/observe/GetBackStack";
import {
  AndroidWindowModeController,
  type WindowModeController,
} from "../features/windowing/WindowModeController";
import {
  FREEFORM_SETTING_KEYS,
  SPLIT_POSITIONS,
  type WindowModeResult,
} from "../features/windowing/WindowModeTypes";

const pixel = z.number().int().min(0);
const boundsSchema = z
  .object({ left: pixel, top: pixel, right: pixel, bottom: pixel })
  .strict()
  .refine(
    (bounds) => bounds.right > bounds.left && bounds.bottom > bounds.top,
    "bounds need right > left and bottom > top",
  )
  .describe("Window bounds in display pixels");

const modeSchema = z.union([
  z.literal("fullscreen"),
  z.object({ pip: z.enum(["enter", "exit"]) }).strict(),
  z.object({ freeform: z.object({ bounds: boundsSchema.optional() }).strict() }).strict(),
  z
    .object({
      splitScreen: z
        .object({
          with: z.string().min(1).optional().describe("Second app's package; required on API 32+"),
          position: z
            .enum(SPLIT_POSITIONS)
            .optional()
            .describe("appId's side: primary is top/left (default)"),
        })
        .strict(),
    })
    .strict(),
]);

const windowModeInput = z.object({
  appId: z.string().min(1).describe("Package whose task to move"),
  mode: modeSchema
    .optional()
    .describe(
      '"fullscreen"; {pip: enter|exit}; {freeform: {bounds?}} (turns on freeform settings, receipted); {splitScreen: {with?, position?}}',
    ),
  restore: z
    .object({
      mode: modeSchema.optional(),
      settings: z
        .object({
          deviceId: z.string(),
          bootId: z.string().uuid(),
          entries: z
            .array(
              z
                .object({
                  key: z.enum(FREEFORM_SETTING_KEYS),
                  value: z.string().regex(/^\d+$/).nullable(),
                })
                .strict(),
            )
            .min(1)
            .max(FREEFORM_SETTING_KEYS.length),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional()
    .describe(
      "A returned restore receipt: puts the window back, then the settings. Same boot only",
    ),
});

type WindowModeArgs = z.output<typeof windowModeInput>;

/** Builds the controller a call drives; injectable so tests substitute a fake. */
export type WindowModeControllerFactory = (device: BootedDevice) => WindowModeController;

const defaultWindowModeControllerFactory: WindowModeControllerFactory = (device) =>
  new AndroidWindowModeController({
    adb: defaultAdbClientFactory.create(device),
    backStack: new GetBackStack(device, defaultAdbClientFactory),
    timer: defaultTimer,
    deviceId: device.deviceId,
  });

function describe(result: WindowModeResult): string {
  const window = result.current
    ? `${result.current.windowingMode} (task ${result.current.taskId}${
        result.current.bounds
          ? ` [${result.current.bounds.left},${result.current.bounds.top}][${result.current.bounds.right},${result.current.bounds.bottom}]`
          : ""
      })`
    : "no task";
  const from = result.previous ? ` from ${result.previous.windowingMode}` : "";
  return result.matched
    ? `${result.appId} is ${window}${from}`
    : `${result.appId} is ${window}${from}: ${result.reason ?? "the requested mode was not reached"}`;
}

function payload(result: WindowModeResult) {
  const { current, previous, partner, reason, restore, settingsRestored } = result;
  return {
    success: result.matched,
    message: describe(result),
    appId: result.appId,
    ...(current
      ? {
          windowingMode: current.windowingMode,
          taskId: current.taskId,
          ...(current.bounds ? { bounds: current.bounds } : {}),
        }
      : {}),
    ...(previous ? { previous } : {}),
    ...(partner ? { partner } : {}),
    ...(result.method ? { method: result.method } : {}),
    attempts: result.attempts,
    settingsChanged: result.settingsChanged,
    ...(settingsRestored ? { settingsRestored } : {}),
    ...(reason ? { reason } : {}),
    ...(restore ? { restore } : {}),
  };
}

export const createWindowModeHandler =
  (makeController: WindowModeControllerFactory = defaultWindowModeControllerFactory) =>
  async (device: BootedDevice, args: WindowModeArgs, _progress?: unknown, signal?: AbortSignal) => {
    if (device.platform !== "android") {
      throw new ActionableError(
        "windowMode is Android-only: it drives Android task windowing through adb.",
      );
    }
    if ((args.mode === undefined) === (args.restore === undefined)) {
      throw new ActionableError("Specify exactly one of mode or restore.");
    }
    const controller = makeController(device);
    const result = args.restore
      ? await controller.restore({ appId: args.appId, restore: args.restore, signal })
      : await controller.setMode({ appId: args.appId, mode: args.mode!, signal });
    return withIsErrorOnFailure(createStructuredToolResponse(payload(result)), result.matched);
  };

const windowModeTool = defineDeviceTool({
  name: "windowMode",
  description:
    "Android: put an app's task into fullscreen, picture-in-picture (enter via HOME; the app must support PiP), freeform (optional bounds) or split screen with a second app, and read the mode and bounds back. Returns a restore receipt for the previous mode and any freeform settings it turned on. observe reports each task's windowingMode and bounds in backStack.tasks.",
  input: windowModeInput,
  handler: createWindowModeHandler(),
  options: {
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    // Plain adb (am, settings, dumpsys, WM Shell commands): no CtrlProxy setup.
    deviceReadiness: "booted",
    outputSchema: windowModeResultSchema,
  },
});

export const windowModeSchema = windowModeTool.schema;

export function registerWindowModeTools() {
  windowModeTool.register();
}
