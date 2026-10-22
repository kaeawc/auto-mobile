import type { BootedDevice } from "../../models";
import { ProvisionDeviceError } from "../../devices/exactDeviceProvisioning";
import type {
  DeviceToolsDependencies,
  ManufacturerProfileApplier,
  ProvisionDeviceArgs,
} from "../../features/deviceLifecycle/deviceLifecycleCore";
import type { ProvisionDeviceProfile } from "../../features/deviceLifecycle/core/schemas";
import {
  applyPersona,
  type ApplyPersonaResult,
  type RoutePersonaResult,
} from "../../features/utility/ApplyPersona";
import { NON_EMULATABLE_CAPABILITIES, OEM_PERSONAS } from "../../features/utility/OemPersonas";
import { defaultPersonaExecutors, toManufacturerProfileResult } from "../personaTools";

/** The requested manufacturer profile, when the request is Android and names one. */
export function requestedDeviceProfile(
  args: ProvisionDeviceArgs,
): ProvisionDeviceProfile | undefined {
  return args.device.platform === "android" ? args.device.spec.deviceProfile : undefined;
}

/**
 * The spec the exact provisioner sees: `deviceProfile` is applied after boot, never part of the
 * AVD definition or its identity (#14058).
 */
export function provisionableDeviceSpec(
  args: ProvisionDeviceArgs,
): ProvisionDeviceArgs["device"]["spec"] {
  if (args.device.platform !== "android" || !args.device.spec.deviceProfile) {
    return args.device.spec;
  }
  const spec = { ...args.device.spec };
  delete spec.deviceProfile;
  return spec;
}

/**
 * Refuse before anything is created or booted when the task needs an OEM capability the
 * manufacturer profile cannot emulate (#14058): a stock emulator can never serve it.
 */
export function assertDeviceProfileEmulatable(args: ProvisionDeviceArgs): void {
  const profile = requestedDeviceProfile(args);
  if (!profile?.requires?.length) {
    return;
  }
  const persona = OEM_PERSONAS[profile.manufacturerProfile];
  const blocked = profile.requires.filter((id) => persona.nonEmulatable.includes(id));
  if (blocked.length === 0) {
    return;
  }
  throw new ProvisionDeviceError(
    "requires_real_device",
    `Manufacturer profile ${persona.id} cannot emulate ${blocked.join(", ")}; run this task on a real ${persona.displayName} device. Nothing was created or booted.`,
    false,
    { capabilities: blocked.map((id) => ({ id, note: NON_EMULATABLE_CAPABILITIES[id] })) },
  );
}

/** The production applier: the manufacturerProfile tool's executors, kill deferred. */
export const defaultManufacturerProfileApplier: ManufacturerProfileApplier = {
  apply: (device, profile, sessionId, signal) =>
    applyPersona(
      device,
      profile.manufacturerProfile,
      { requires: profile.requires, deferKill: true },
      {
        executors: defaultPersonaExecutors(device, signal),
        owner: sessionId,
        restoreKeyboardOnRelease: true,
        signal,
      },
    ),
};

/**
 * Apply the requested manufacturer profile to the bound session's ready device. Its release
 * restores the display, keyboard and (once applied) kill facets.
 */
export async function applyProvisionDeviceProfile(
  args: ProvisionDeviceArgs,
  deps: Pick<DeviceToolsDependencies, "manufacturerProfileApplier">,
  device: BootedDevice,
  sessionId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const profile = requestedDeviceProfile(args);
  if (!profile) {
    return undefined;
  }
  const applier = deps.manufacturerProfileApplier ?? defaultManufacturerProfileApplier;
  const result: ApplyPersonaResult | RoutePersonaResult = await applier.apply(
    device,
    profile,
    sessionId,
    signal,
  );
  return toManufacturerProfileResult(result);
}
