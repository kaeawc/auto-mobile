import { z } from "zod/v4";
import { ActionableError, type BootedDevice } from "../models";
import { errorMessage } from "../models/describeUnknownError";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { formFactorFrom } from "../models/formFactor";
import {
  GrpcXrHeadsetInputInjector,
  resolveXrInputEndpoint,
  XR_DEFAULT_DRAG_MS,
  XR_DEFAULT_HOLD_MS,
  XR_MAX_COORDINATE,
  XR_MAX_DRAG_MS,
  XR_MAX_HOLD_MS,
  XR_POINTER_ACTIONS,
  XR_POINTERS,
  type XrHeadsetInputInjector,
} from "../features/xr/XrHeadsetInput";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import {
  defaultDeviceTraits,
  type DeviceTraits,
} from "../utils/android-cmdline-tools/deviceTraits";
import { createGrpcAuthorizer } from "../utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcAuth";
import { FileEmulatorGrpcDiscovery } from "../utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";
import { EmulatorInputEventClient } from "../utils/android-cmdline-tools/emulatorGrpc/EmulatorInputEventClient";
import { Http2GrpcTransport } from "../utils/android-cmdline-tools/emulatorGrpc/grpcTransport";
import { DefaultFileSystem } from "../utils/filesystem/DefaultFileSystem";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { readTraitFormFactor } from "./bootedDeviceTraits";
import { defineDeviceTool } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";

const coordinate = z.number().int().min(0).max(XR_MAX_COORDINATE);

const xrHeadsetInput = z.object({
  pointer: z
    .enum(XR_POINTERS)
    .describe("hand: right-hand ray and pinch; eye: gaze point and click"),
  action: z
    .enum(XR_POINTER_ACTIONS)
    .describe("select: aim, press, release; point: aim only; drag: pinch-drag (hand only)"),
  x: coordinate.describe("Display x in pixels, as in observe screenSize"),
  y: coordinate.describe("Display y in pixels"),
  toX: coordinate.optional().describe("drag: release x"),
  toY: coordinate.optional().describe("drag: release y"),
  holdMs: z
    .number()
    .int()
    .min(0)
    .max(XR_MAX_HOLD_MS)
    .optional()
    .describe(`select: press length in ms, default ${XR_DEFAULT_HOLD_MS}`),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(XR_MAX_DRAG_MS)
    .optional()
    .describe(`drag: duration in ms, default ${XR_DEFAULT_DRAG_MS}`),
});

export const xrHeadsetInputResultSchema = z
  .object({
    success: z.boolean(),
    message: z.string(),
    pointer: z.enum(XR_POINTERS),
    action: z.enum(XR_POINTER_ACTIONS),
    rpc: z.string(),
    field: z.enum(["xr_hand_event", "xr_eye_event"]),
    events: z.array(z.object({ x: z.number(), y: z.number(), buttons: z.number() })),
  })
  .passthrough();

/** True when the device is an XR headset, undefined when its traits could not be read. */
export type HeadsetCheck = (device: BootedDevice) => Promise<boolean | undefined>;

export function traitsHeadsetCheck(
  traits: DeviceTraits,
  adbFactory: AdbClientFactory,
): HeadsetCheck {
  return async (device) => {
    const profile = formFactorFrom({
      systemImageTag: device.runtimeId?.split(";")[2],
      deviceType: device.deviceType,
      hint: device.formFactor,
    });
    if (profile === "xr-headset") {
      return true;
    }
    const formFactor = await readTraitFormFactor(traits, adbFactory, device, "xrHeadsetInput");
    return formFactor === undefined ? undefined : formFactor === "xr-headset";
  };
}

async function defaultInjector(device: BootedDevice): Promise<XrHeadsetInputInjector> {
  const fs = new DefaultFileSystem();
  const endpoint = await resolveXrInputEndpoint(device.deviceId, new FileEmulatorGrpcDiscovery(fs));
  return new GrpcXrHeadsetInputInjector(
    new EmulatorInputEventClient(
      new Http2GrpcTransport(endpoint.address),
      createGrpcAuthorizer(endpoint.auth, fs),
    ),
  );
}

/** The guest logs this once per pointer event its simulated input manager does not understand. */
export const XR_GUEST_REJECTION_LOG =
  "Received unexpected message type from simulated input client";
const XR_GUEST_LOG_SETTLE_MS = 500;

/** Number of pointer events the guest has rejected so far, or undefined when logcat is unreadable. */
export type GuestRejectionCounter = (device: BootedDevice) => Promise<number | undefined>;

export function logcatGuestRejectionCounter(adbFactory: AdbClientFactory): GuestRejectionCounter {
  return async (device) => {
    try {
      const { stdout } = await adbFactory
        .create(device)
        .executeCommand("logcat -d -s XrSimulatedInputManager:W", { timeoutMs: 5_000 });
      return stdout.split("\n").filter((line) => line.includes(XR_GUEST_REJECTION_LOG)).length;
    } catch (error) {
      // Delivery verification is best-effort; the input itself was already sent.
      logger.warn(`xrHeadsetInput could not read the guest log: ${errorMessage(error)}`, error);
      return undefined;
    }
  };
}

export function rejectedByGuestMessage(rejected: number, sent: number): string {
  return `The emulator accepted ${sent} event(s) but the guest's XrSimulatedInputManager rejected ${rejected} of them ("${XR_GUEST_REJECTION_LOG}"), so the hand/eye input had no effect. This emulator and system image do not agree on the XR pointer message (seen with emulator 37.2.13 and the google-xr canary 8.0.0 image). Use tapOn on the panel instead, or try a google-xr image that matches the emulator.`;
}

export const createXrHeadsetInputHandler =
  (
    makeInjector: (device: BootedDevice) => Promise<XrHeadsetInputInjector> = defaultInjector,
    checkHeadset: HeadsetCheck = traitsHeadsetCheck(defaultDeviceTraits, defaultAdbClientFactory),
    countRejections: GuestRejectionCounter = logcatGuestRejectionCounter(defaultAdbClientFactory),
    timer: Pick<Timer, "sleep"> = defaultTimer,
  ) =>
  async (
    device: BootedDevice,
    args: z.output<typeof xrHeadsetInput>,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    if (device.platform !== "android") {
      throw new ActionableError(
        "xrHeadsetInput is Android-only: it drives the Android XR headset emulator's gRPC input stream.",
      );
    }
    const headset = await checkHeadset(device);
    if (headset !== true) {
      throw new ActionableError(
        headset === false
          ? `xrHeadsetInput only works on an Android XR headset emulator; ${device.deviceId} is not one. Check formFactor in listDevices, or use tapOn on other devices.`
          : `Could not read the traits of ${device.deviceId}, so it is not confirmed as an Android XR headset. Check that the device is online and listDevices reports formFactor xr-headset, then retry.`,
      );
    }
    const injector = await makeInjector(device);
    const before = await countRejections(device);
    const result = await injector.inject({ ...args, signal });
    if (before === undefined) {
      return createStructuredToolResponse(result);
    }
    await timer.sleep(XR_GUEST_LOG_SETTLE_MS);
    const after = await countRejections(device);
    const rejected = after === undefined ? 0 : after - before;
    if (rejected <= 0) {
      return createStructuredToolResponse(result);
    }
    return createStructuredToolResponse({
      ...result,
      success: false,
      guestRejected: rejected,
      message: rejectedByGuestMessage(rejected, result.events.length),
    });
  };

const xrHeadsetInputTool = defineDeviceTool({
  name: "xrHeadsetInput",
  description:
    "Android XR headset emulator hand and eye input. pointer hand aims the right-hand ray at a display point and pinches; pointer eye moves the gaze point and clicks. action select aims, presses and releases; point only aims (hover); drag pinch-drags from x,y to toX,toY (hand only). Coordinates are display pixels. Sent over the emulator's gRPC streamInputEvent (emulator 35.4+); the emulator returns no acknowledgement, so observe afterwards. Refused on devices that are not XR headset emulators.",
  input: xrHeadsetInput,
  handler: createXrHeadsetInputHandler(),
  options: {
    ...PLAN_RELEVANT,
    defaultEnabled: false,
    outputSchema: xrHeadsetInputResultSchema,
  },
});
export const xrHeadsetInputSchema = xrHeadsetInputTool.schema;
export function registerXrHeadsetInputTools() {
  xrHeadsetInputTool.register();
}
