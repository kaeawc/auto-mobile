import { z } from "zod/v4";
import { ActionableError, type BootedDevice } from "../models";
import { toActionableError } from "../models/ActionableError";
import { AdbAmbient, type Ambient } from "../features/wear/Ambient";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultDeviceTraits } from "../utils/android-cmdline-tools/deviceTraits";
import { requireWatch, traitsFormFactorRead, type FormFactorRead } from "./requireWatch";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { defineDeviceTool } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";

const ambientInput = z.strictObject({ action: z.enum(["enter", "exit"]) });

export const ambientResultSchema = z.object({
  success: z.boolean(),
  action: z.enum(["enter", "exit"]),
  ambient: z.union([z.boolean(), z.literal("unknown")]),
  watchFaceVisible: z.boolean().optional(),
  wakefulness: z.enum(["Awake", "Asleep", "Dozing"]).optional(),
  message: z.string(),
  reason: z.string().optional(),
});

export type AmbientFactory = (device: BootedDevice) => Ambient;
const defaultAmbientFactory: AmbientFactory = (device) =>
  new AdbAmbient(defaultAdbClientFactory.create(device));

const defaultFormFactorRead = traitsFormFactorRead(
  defaultDeviceTraits,
  defaultAdbClientFactory,
  "ambient",
);

/** KEYCODE_SLEEP puts a phone to sleep (#17051), so anything not confirmed to be a watch is refused. */
const AMBIENT_REFUSAL = { tool: "ambient", purpose: "ambient power-state tests" };

export const createAmbientHandler =
  (
    makeAmbient: AmbientFactory = defaultAmbientFactory,
    readFormFactor: FormFactorRead = defaultFormFactorRead,
  ) =>
  async (
    device: BootedDevice,
    args: z.output<typeof ambientInput>,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    if (device.platform !== "android") {
      throw new ActionableError(
        "ambient is Android-only: it changes Wear OS power state over adb.",
      );
    }
    await requireWatch(device, readFormFactor, AMBIENT_REFUSAL);
    try {
      const result = await makeAmbient(device).change(args.action, signal);
      return withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
    } catch (error) {
      throw toActionableError(error, `Failed to ${args.action} ambient power state`);
    }
  };

const ambientTool = defineDeviceTool({
  name: "ambient",
  description:
    'Wear OS watches only (other form factors are refused without a change): enter sends KEYCODE_SLEEP, exit sends KEYCODE_WAKEUP, then reads wakefulness and the watch face\'s inAmbient from dumpsys wear_service, reported as ambient (true, false or "unknown"). Enter succeeds when inAmbient is true; exit when inAmbient is false and wakefulness is Awake. Without that readback, enter succeeds on Dozing or Asleep and exit on Awake. Hardware wake by tilt or touch is untested.',
  input: ambientInput,
  handler: createAmbientHandler(),
  options: { ...PLAN_RELEVANT, defaultEnabled: false, outputSchema: ambientResultSchema },
});

export const ambientSchema = ambientTool.schema;
export function registerAmbientTools() {
  ambientTool.register();
}
