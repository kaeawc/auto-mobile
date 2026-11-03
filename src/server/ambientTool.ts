import { z } from "zod/v4";
import { ActionableError, type BootedDevice } from "../models";
import { toActionableError } from "../models/ActionableError";
import { AdbAmbient, type Ambient } from "../features/wear/Ambient";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { defineDeviceTool } from "./defineTool";
import { PLAN_RELEVANT } from "./toolRegistryTypes";

const ambientInput = z.strictObject({ action: z.enum(["enter", "exit"]) });

export const ambientResultSchema = z.object({
  success: z.boolean(),
  action: z.enum(["enter", "exit"]),
  wakefulness: z.enum(["Awake", "Asleep", "Dozing"]).optional(),
  message: z.string(),
  reason: z.string().optional(),
});

export type AmbientFactory = (device: BootedDevice) => Ambient;
const defaultAmbientFactory: AmbientFactory = (device) =>
  new AdbAmbient(defaultAdbClientFactory.create(device));

export const createAmbientHandler =
  (makeAmbient: AmbientFactory = defaultAmbientFactory) =>
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
    "Wear OS power-state change: enter sends KEYCODE_SLEEP, exit sends KEYCODE_WAKEUP, then reads wakefulness once. Enter succeeds on Dozing or Asleep; exit succeeds on Awake. Wear exposes no ambient readback, so success does not prove ambient mode. Hardware wake by tilt or touch is untested.",
  input: ambientInput,
  handler: createAmbientHandler(),
  options: { ...PLAN_RELEVANT, defaultEnabled: false, outputSchema: ambientResultSchema },
});

export const ambientSchema = ambientTool.schema;
export function registerAmbientTools() {
  ambientTool.register();
}
