import { z } from "zod/v4";
import type { BootedDevice } from "../models";
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
import { ActionableError } from "../models/ActionableError";
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
    warningCode: z.enum(["traits_unavailable"]).optional(),
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

/**
 * The ai-glasses image reports `watch` characteristics but a `sdk_glasses_*` product device. A
 * failed read is unknown, not "not glasses", so a glasses device is never refused for it.
 */
async function productNamesGlasses(
  adbFactory: AdbClientFactory,
  device: BootedDevice,
): Promise<boolean | undefined> {
  try {
    const result = await adbFactory
      .create(device)
      .executeCommand("shell getprop ro.product.device", { timeoutMs: 5_000, noRetry: true });
    return /glasses/i.test(result.stdout);
  } catch (error) {
    logger.warn(`glassesInput product probe failed: ${errorMessage(error)}`, error);
    return undefined;
  }
}

/**
 * The refusal for a device confirmed not to be Android XR glasses (#19179): DPAD center would
 * click whatever has focus on a watch, TV or phone, so no key is sent.
 */
export function notGlassesError(device: BootedDevice): ActionableError {
  return new ActionableError(
    `glassesInput only works on Android XR glasses; ${device.deviceId} is not glasses, so no key was sent. Check formFactor in listDevices, or use pressButton or tapOn on other devices.`,
  );
}

function glassesWarning(glasses: true | undefined) {
  return glasses === true
    ? undefined
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
    const glasses = await checkGlasses(device);
    if (glasses === false) {
      throw notGlassesError(device);
    }
    const warning = glassesWarning(glasses);
    const result = await makeInjector(device).inject({ ...args, signal });
    return withIsErrorOnFailure(
      createStructuredToolResponse({ ...result, ...warning }),
      result.success,
    );
  };

const glassesInputTool = defineDeviceTool({
  name: "glassesInput",
  description:
    "Android XR glasses touchpad tap and forward/back swipe as focus input. Tap clicks the focused item; swipeForward/swipeBack move focus using DPAD keys (vertical down/up by default, horizontal right/left). count repeats any gesture 1..20 times. Success means adb commands exited cleanly; no read-back is performed, so observe afterwards. Voice input uses the existing injectAudioInput tool. Long press and two-finger gestures are not injectable yet: key holds produce no long click and raw touchpad holds/gestures are swallowed by the unpaired glasses system UI (raw input also requires adb root). Direct DPAD avoids unreliable touchnavigation swipes and touchpad motion that does not change focus. Devices that are not glasses are refused without sending a key; when the traits cannot be read, input is sent with a warning.",
  input: glassesInput,
  handler: createGlassesInputHandler(),
  options: {
    platforms: ["android"],
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
