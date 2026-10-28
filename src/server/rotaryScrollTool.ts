import { z } from "zod/v4";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { defineDeviceTool } from "./defineTool";
import { ActionableError, type BootedDevice } from "../models";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultTimer } from "../utils/SystemTimer";
import { hierarchyFingerprint } from "../utils/hierarchyFingerprint";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { hasUsableHierarchy } from "../features/observe/ActiveWindowAttribution";
import {
  defaultDeviceTraits,
  isWatch,
  type DeviceTraits,
} from "../utils/android-cmdline-tools/deviceTraits";
import { DEVICE_TRAITS_TIMEOUT_MS } from "./bootedDeviceTraits";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import type { ObserveResult } from "../models";
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
    warning: z
      .string()
      .optional()
      .describe("Set when the device is not confirmed to be a watch; the input is still sent"),
  })
  .passthrough();

type RotaryScrollArgs = z.output<typeof rotaryScrollInput>;

/**
 * An error-shaped hierarchy (CtrlProxy disconnected) is not a screen: hashing it would let a
 * changed diagnostic count as a scroll, so it reads as unavailable.
 */
export function screenFingerprint(
  observation: Pick<ObserveResult, "viewHierarchy">,
): string | undefined {
  return hasUsableHierarchy(observation.viewHierarchy)
    ? (hierarchyFingerprint(observation.viewHierarchy) ?? undefined)
    : undefined;
}

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
      return screenFingerprint(observation);
    },
  });

/**
 * Whether the device announces a watch build (`ro.build.characteristics`, #14897); undefined
 * when the traits could not be read. Injectable so tests never touch adb.
 */
export type WatchCheck = (device: BootedDevice) => Promise<boolean | undefined>;

export function traitsWatchCheck(traits: DeviceTraits, adbFactory: AdbClientFactory): WatchCheck {
  return async (device) => {
    try {
      const read = await traits.read(adbFactory.create(device), device.deviceId, {
        timeoutMs: DEVICE_TRAITS_TIMEOUT_MS,
      });
      return isWatch(read);
    } catch (error) {
      logger.warn(`rotaryScroll could not read device traits: ${errorMessage(error)}`, error);
      return undefined;
    }
  };
}

const defaultWatchCheck = traitsWatchCheck(defaultDeviceTraits, defaultAdbClientFactory);

/** Most phones ignore rotary events, so a scroll on one is worth flagging (#14902). */
export function watchWarning(watch: boolean | undefined): string | undefined {
  if (watch === true) {
    return undefined;
  }
  return watch === false
    ? "This device does not announce a watch build (ro.build.characteristics); most phones and tablets ignore rotary input."
    : "Could not read the device traits to confirm this is a watch; rotary input may be ignored.";
}

function payload(result: RotaryScrollResult, warning: string | undefined) {
  return {
    success: result.success,
    message: result.success
      ? `Scrolled ${result.delta} detents with ${result.method}`
      : (result.reason ?? "Rotary scroll did not change the screen"),
    delta: result.delta,
    ...(result.method ? { method: result.method } : {}),
    attempts: result.attempts,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(warning ? { warning } : {}),
  };
}

export const createRotaryScrollHandler =
  (
    makeScroller: RotaryScrollerFactory = defaultRotaryScrollerFactory,
    checkWatch: WatchCheck = defaultWatchCheck,
  ) =>
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
    const warning = watchWarning(await checkWatch(device));
    const result = await makeScroller(device).scroll({ delta: args.delta, signal });
    return withIsErrorOnFailure(
      createStructuredToolResponse(payload(result, warning)),
      result.success,
    );
  };

const rotaryScrollTool = defineDeviceTool({
  name: "rotaryScroll",
  description:
    "Wear OS: scroll with the rotary crown. Tries `input rotaryencoder scroll`, the emulator console and finally a vertical swipe, in that order, and after each reads the screen back; success means the screen changed. Returns the method that worked and every attempt. The commands are unconfirmed on real images (see docs/design-docs/plat/android/form-factors.md), so check attempts. A screen that does not move when scrolled (already at the end) reports unchanged. On a device that does not announce a watch build the input is still sent and the result carries a warning.",
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
