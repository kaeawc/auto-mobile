import type { SessionConfig } from "../../devices/sessionConfig";
import type { DeviceProfileSelector } from "../../models/ManufacturerProfileIds";
import { NON_EMULATABLE_CAPABILITIES, OEM_PERSONAS } from "../../features/utility/OemPersonas";
import { SessionBrokerFailureError } from "./devicePort";

/** The Android `deviceProfile` a session request names, if any (#14058). */
export function requestedDeviceProfile(config: SessionConfig): DeviceProfileSelector | undefined {
  return config.device.platform === "android" ? config.device.deviceProfile : undefined;
}

/**
 * Refuse before admission reserves anything when the task needs an OEM capability the
 * manufacturer profile cannot emulate: no pooled or created emulator can serve it (#14058).
 */
export function assertDeviceProfileEmulatable(profile: DeviceProfileSelector | undefined): void {
  if (!profile?.requires?.length) {
    return;
  }
  const persona = OEM_PERSONAS[profile.manufacturerProfile];
  const blocked = profile.requires.filter((id) => persona.nonEmulatable.includes(id));
  if (blocked.length === 0) {
    return;
  }
  throw new SessionBrokerFailureError({
    code: "requires_real_device",
    message:
      `Manufacturer profile ${persona.id} cannot emulate ${blocked.join(", ")} ` +
      `(${blocked.map((id) => NON_EMULATABLE_CAPABILITIES[id]).join(" ")}); run this task on a ` +
      `real ${persona.displayName} device.`,
    retryable: false,
  });
}
