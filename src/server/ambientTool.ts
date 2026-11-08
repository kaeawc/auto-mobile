import { z } from "zod/v4";
import { ActionableError, type BootedDevice } from "../models";
import { toActionableError } from "../models/ActionableError";
import { AdbAmbient, type Ambient } from "../features/wear/Ambient";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import {
  defaultDeviceTraits,
  type DeviceTraits,
  type TraitFormFactor,
} from "../utils/android-cmdline-tools/deviceTraits";
import { readTraitFormFactor } from "./bootedDeviceTraits";
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

/** See {@link readTraitFormFactor}; injectable so tests never touch adb. */
export type FormFactorRead = (device: BootedDevice) => Promise<TraitFormFactor | null | undefined>;

export function traitsFormFactorRead(
  traits: DeviceTraits,
  adbFactory: AdbClientFactory,
): FormFactorRead {
  return (device) => readTraitFormFactor(traits, adbFactory, device, "ambient");
}

const defaultFormFactorRead = traitsFormFactorRead(defaultDeviceTraits, defaultAdbClientFactory);

/**
 * KEYCODE_SLEEP puts a phone to sleep (#17051), so anything not confirmed to be a watch is
 * refused before any power-state command. A null trait is not proof of a non-watch (a failed
 * characteristics getprop also reads null), so a session recorded as a watch is trusted unless
 * the build names another form factor.
 */
async function requireWatch(device: BootedDevice, readFormFactor: FormFactorRead): Promise<void> {
  const announced = await readFormFactor(device);
  if (announced === "watch" || (!announced && device.formFactor === "watch")) {
    return;
  }
  const formFactor =
    announced ??
    device.formFactor ??
    (announced === null ? "phone or tablet (no watch build announced)" : "unknown");
  const unreadable =
    announced === undefined
      ? " The device traits could not be read; check the device with listDevices (formFactor)."
      : "";
  throw new ActionableError(
    `ambient requires a Wear OS watch; this device's form factor is ${formFactor}, so nothing was changed.${unreadable} Use a Wear OS emulator (formFactor: "watch") for ambient power-state tests.`,
  );
}

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
    await requireWatch(device, readFormFactor);
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
    "Wear OS watches only (other form factors are refused without a change): power-state change. enter sends KEYCODE_SLEEP, exit sends KEYCODE_WAKEUP, then reads wakefulness once. Enter succeeds on Dozing or Asleep; exit succeeds on Awake. Wear exposes no ambient readback, so success does not prove ambient mode. Hardware wake by tilt or touch is untested.",
  input: ambientInput,
  handler: createAmbientHandler(),
  options: { ...PLAN_RELEVANT, defaultEnabled: false, outputSchema: ambientResultSchema },
});

export const ambientSchema = ambientTool.schema;
export function registerAmbientTools() {
  ambientTool.register();
}
