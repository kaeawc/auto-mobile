import { ActionableError, type BootedDevice } from "../models";
import type { AdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { DeviceTraits, TraitFormFactor } from "../utils/android-cmdline-tools/deviceTraits";
import { readTraitFormFactor } from "./bootedDeviceTraits";

/** See {@link readTraitFormFactor}; injectable so tests never touch adb. */
export type FormFactorRead = (device: BootedDevice) => Promise<TraitFormFactor | null | undefined>;

export function traitsFormFactorRead(
  traits: DeviceTraits,
  adbFactory: AdbClientFactory,
  caller: string,
): FormFactorRead {
  return (device) => readTraitFormFactor(traits, adbFactory, device, caller);
}

/**
 * Refuses anything not confirmed to be a watch before a watch-only command runs. A null trait is
 * not proof of a non-watch (a failed characteristics getprop also reads null), so a session
 * recorded as a watch is trusted unless the build names another form factor.
 */
export async function requireWatch(
  device: BootedDevice,
  readFormFactor: FormFactorRead,
  refusal: { tool: string; purpose: string },
): Promise<void> {
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
    `${refusal.tool} requires a Wear OS watch; this device's form factor is ${formFactor}, so nothing was changed.${unreadable} Use a Wear OS emulator (formFactor: "watch") for ${refusal.purpose}.`,
  );
}
