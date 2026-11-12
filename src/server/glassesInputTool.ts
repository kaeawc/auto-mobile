import { z } from "zod/v4";
import { ActionableError, type BootedDevice } from "../models";
import { formFactorFrom } from "../models/formFactor";
import {
  AdbGlassesInputInjector,
  GLASSES_AXES,
  GLASSES_GESTURES,
  GLASSES_MAX_COUNT,
  type GlassesInputInjector,
} from "../features/xr/GlassesInput";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import {
  defaultDeviceTraits,
  type DeviceTraits,
} from "../utils/android-cmdline-tools/deviceTraits";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { readTraitFormFactor } from "./bootedDeviceTraits";
import { defineDeviceTool } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";

const glassesInput = z.object({
  gesture: z
    .enum(GLASSES_GESTURES)
    .describe("tap clicks focus; swipeForward/swipeBack move focus along axis"),
  axis: z.enum(GLASSES_AXES).optional().describe("Focus axis, default vertical; ignored for tap"),
  count: z
    .number()
    .int()
    .min(1)
    .max(GLASSES_MAX_COUNT)
    .optional()
    .describe("Repeat the gesture 1..20 times, default 1 (including tap)"),
});

export const glassesInputResultSchema = z
  .object({
    success: z.boolean(),
    message: z.string(),
    gesture: z.enum(GLASSES_GESTURES),
    axis: z.enum(GLASSES_AXES),
    count: z.number().int().min(1).max(GLASSES_MAX_COUNT),
    keyCodes: z.array(z.string()),
    commands: z.array(z.string()),
    warningCode: z.enum(["not_glasses", "traits_unavailable"]).optional(),
    warning: z.string().optional(),
  })
  .passthrough();

export type GlassesCheck = (device: BootedDevice) => Promise<boolean | undefined>;

export function traitsGlassesCheck(
  traits: DeviceTraits,
  adbFactory: AdbClientFactory,
): GlassesCheck {
  return async (device) => {
    const formFactor = await readTraitFormFactor(traits, adbFactory, device, "glassesInput");
    if (formFactor === "xr-glasses") {
      return true;
    }
    // The ai-glasses image announces watch; profile/runtime identity disambiguates it.
    const profile = formFactorFrom({
      systemImageTag: device.runtimeId?.split(";")[2],
      deviceType: device.deviceType,
      hint: device.formFactor,
    });
    if (profile === "xr-glasses") {
      return true;
    }
    if (formFactor === undefined) {
      return undefined;
    }
    return formFactor === "watch" ? await productNamesGlasses(adbFactory, device) : false;
  };
}

/** The ai-glasses image reports `watch` characteristics but a `sdk_glasses_*` product device. */
async function productNamesGlasses(
  adbFactory: AdbClientFactory,
  device: BootedDevice,
): Promise<boolean> {
  try {
    const result = await adbFactory
      .create(device)
      .executeCommand("shell getprop ro.product.device", { timeoutMs: 5_000, noRetry: true });
    return /glasses/i.test(result.stdout);
  } catch (error) {
    logger.warn(`glassesInput product probe failed: ${errorMessage(error)}`, error);
    return false;
  }
}

function glassesWarning(glasses: boolean | undefined) {
  if (glasses === true) {
    return undefined;
  }
  return glasses === false
    ? {
        warningCode: "not_glasses" as const,
        warning:
          "This device is not confirmed as Android XR glasses. DPAD input is still sent and may move or click focus. Use observe afterwards to verify the effect.",
      }
    : {
        warningCode: "traits_unavailable" as const,
        warning:
          "Could not read the device traits, so glasses status is unknown. Check observe or listDevices (formFactor) before trusting the result.",
      };
}

export const createGlassesInputHandler =
  (
    makeInjector: (device: BootedDevice) => GlassesInputInjector = (device) =>
      new AdbGlassesInputInjector(defaultAdbClientFactory.create(device)),
    checkGlasses: GlassesCheck = traitsGlassesCheck(defaultDeviceTraits, defaultAdbClientFactory),
  ) =>
  async (
    device: BootedDevice,
    args: z.output<typeof glassesInput>,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    if (device.platform !== "android") {
      throw new ActionableError(
        "glassesInput is Android-only: it sends glasses focus input over adb.",
      );
    }
    const warning = glassesWarning(await checkGlasses(device));
    const result = await makeInjector(device).inject({ ...args, signal });
    return withIsErrorOnFailure(
      createStructuredToolResponse({ ...result, ...warning }),
      result.success,
    );
  };

const glassesInputTool = defineDeviceTool({
  name: "glassesInput",
  description:
    "Android XR glasses touchpad tap and forward/back swipe as focus input. Tap clicks the focused item; swipeForward/swipeBack move focus using DPAD keys (vertical down/up by default, horizontal right/left). count repeats any gesture 1..20 times. Success means adb commands exited cleanly; no read-back is performed, so observe afterwards. Voice input uses the existing injectAudioInput tool. Long press and two-finger gestures are not injectable yet: key holds produce no long click and raw touchpad holds/gestures are swallowed by the unpaired glasses system UI (raw input also requires adb root). Direct DPAD avoids unreliable touchnavigation swipes and touchpad motion that does not change focus. Unconfirmed glasses receive a warning but input is still sent.",
  input: glassesInput,
  handler: createGlassesInputHandler(),
  options: {
    ...PLAN_RELEVANT,
    // `tap` can open another screen, so record the call like tapOn and sendKeys for navigateTo to replay.
    recordsNavigation: true,
    defaultEnabled: false,
    outputSchema: glassesInputResultSchema,
  },
});
export const glassesInputSchema = glassesInputTool.schema;
export function registerGlassesInputTools() {
  glassesInputTool.register();
}
