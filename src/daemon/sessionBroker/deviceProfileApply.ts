import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import type { ManufacturerProfileApplier } from "../../features/utility/personaExecutors";
import type { SessionDevicePreparationOptions } from "./devicePort";
import type { BrokerDeviceAcquisitionResult } from "./managedDevicePort";

/**
 * Apply the request's manufacturer profile to the prepared session's device (#14058). Its
 * release restores what it changed; a failure fails preparation like a readiness failure.
 */
export async function applyDeviceProfile(input: {
  knownDevice: BootedDevice | undefined;
  result: BrokerDeviceAcquisitionResult;
  applier: ManufacturerProfileApplier;
  sessionId: string;
  options: SessionDevicePreparationOptions;
}): Promise<void> {
  const { knownDevice, result, applier, sessionId, options } = input;
  const deviceProfile = options.deviceProfile;
  if (!deviceProfile) {
    return;
  }
  const applied = await applier.apply(
    knownDevice ?? acquiredAndroidDevice(result),
    deviceProfile,
    sessionId,
    options.signal,
  );
  if (applied.status === "route_to_real_device") {
    throw new ActionableError(applied.message);
  }
  logger.info(`[SessionBroker] ${applied.message}`);
}

/** The acquired Android emulator as a booted device, for work on the prepared session. */
function acquiredAndroidDevice(result: BrokerDeviceAcquisitionResult): BootedDevice {
  const binding = result.bindings[0]?.device;
  if (!binding?.transportId) {
    throw new ActionableError("A manufacturer profile requires the acquired emulator serial");
  }
  return { platform: "android", name: binding.name, deviceId: binding.transportId };
}
