import { z } from "zod/v4";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { defineDeviceTool } from "./defineTool";
import { ActionableError, type BootedDevice } from "../models";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultTimer } from "../utils/SystemTimer";
import { hierarchyFingerprint } from "../utils/hierarchyFingerprint";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import {
  AdbRotaryScroller,
  ROTARY_MAX_DELTA,
  ROTARY_METHODS,
  type RotaryScroller,
  type RotaryScrollResult,
} from "../features/wear/RotaryScroll";

const rotaryScrollInput = z.object({
  delta: z
    .number()
    .int()
    .min(-ROTARY_MAX_DELTA)
    .max(ROTARY_MAX_DELTA)
    .refine((value) => value !== 0, "delta must not be 0")
    .describe("Crown detents: positive scrolls content down (clockwise), negative scrolls up"),
});

/** `success` is false when no candidate changed the screen on read-back (#14948). */
export const rotaryScrollResultSchema = z
  .object({
    success: z.boolean(),
    message: z.string(),
    delta: z.number(),
    method: z
      .enum(ROTARY_METHODS)
      .optional()
      .describe("The first candidate whose read-back showed the screen change"),
    attempts: z.array(
      z.object({
        method: z.enum(ROTARY_METHODS),
        command: z.string(),
        outcome: z.enum(["scrolled", "unchanged", "failed"]),
        error: z.string().optional(),
      }),
    ),
    reason: z.string().optional(),
  })
  .passthrough();

type RotaryScrollArgs = z.output<typeof rotaryScrollInput>;

/** Builds the scroller a call drives; injectable so tests substitute a fake. */
export type RotaryScrollerFactory = (device: BootedDevice) => RotaryScroller;

const defaultRotaryScrollerFactory: RotaryScrollerFactory = (device) =>
  new AdbRotaryScroller({
    adb: defaultAdbClientFactory.create(device),
    timer: defaultTimer,
    deviceId: device.deviceId,
    fingerprint: async (signal) => {
      const observation = await new RealObserveScreen(device, undefined, {
        deviceReadOnly: true,
      }).execute({
        hierarchyOnly: true,
        observerMode: true,
        skipScreenshot: true,
        skipBackStack: true,
        requireFreshExtraction: true,
        signal,
      });
      return hierarchyFingerprint(observation.viewHierarchy) ?? undefined;
    },
  });

function payload(result: RotaryScrollResult) {
  return {
    success: result.success,
    message: result.success
      ? `Scrolled ${result.delta} detents with ${result.method}`
      : (result.reason ?? "Rotary scroll did not change the screen"),
    delta: result.delta,
    ...(result.method ? { method: result.method } : {}),
    attempts: result.attempts,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

export const createRotaryScrollHandler =
  (makeScroller: RotaryScrollerFactory = defaultRotaryScrollerFactory) =>
  async (
    device: BootedDevice,
    args: RotaryScrollArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    if (device.platform !== "android") {
      throw new ActionableError(
        "rotaryScroll is Android-only: it drives a Wear OS crown over adb.",
      );
    }
    const result = await makeScroller(device).scroll({ delta: args.delta, signal });
    return withIsErrorOnFailure(createStructuredToolResponse(payload(result)), result.success);
  };

const rotaryScrollTool = defineDeviceTool({
  name: "rotaryScroll",
  description:
    "Wear OS: scroll with the rotary crown. Tries `input rotaryencoder scroll`, the emulator console and finally a vertical swipe, in that order, and after each reads the screen back; success means the screen changed. Returns the method that worked and every attempt. The commands are unconfirmed on real images (see docs/design-docs/plat/android/form-factors.md), so check attempts. A screen that does not move when scrolled (already at the end) reports unchanged.",
  input: rotaryScrollInput,
  handler: createRotaryScrollHandler(),
  options: {
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    outputSchema: rotaryScrollResultSchema,
  },
});

export const rotaryScrollSchema = rotaryScrollTool.schema;

export function registerRotaryScrollTools() {
  rotaryScrollTool.register();
}
