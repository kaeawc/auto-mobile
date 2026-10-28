import type { BootedDevice } from "../../models";
import {
  AUDIO_INPUT_UNAVAILABLE,
  type AudioInputDiagnostic,
} from "../../models/AudioInputDiagnostic";
import type { VirtualDeviceCapability } from "../../models/virtualDeviceCapabilities";
import { resolveIosDeviceKind } from "../ios-cmdline-tools/IosDeviceKind";
import { iosSimulatorAudioCapabilities } from "./audioCapabilities";
import { hostAudioSnapshot } from "./defaultHostAudioProbe";
import type { HostAudioSnapshot } from "./hostAudio";

const AUDIO_INPUT_CAPABILITY_IDS = new Set([
  "ios.simulator.audioInput",
  "android.emulator.audioInput",
]);

/**
 * The diagnostic for an audio-input capability entry that is not available, or undefined when the
 * entries say input works or do not mention it. Derived from the capability inventory (#13626) so
 * there is one detection path.
 */
export function audioInputDiagnosticFromCapabilities(
  capabilities: readonly VirtualDeviceCapability[],
): AudioInputDiagnostic | undefined {
  const entry = capabilities.find(
    (capability) =>
      AUDIO_INPUT_CAPABILITY_IDS.has(capability.id) && capability.state !== "available",
  );
  if (!entry) {
    return undefined;
  }
  const cause = entry.reason ?? "This device has no audio input.";
  return {
    code: AUDIO_INPUT_UNAVAILABLE,
    message:
      `${cause} Recordings on this device will contain no audio. This is an environment ` +
      "limitation, not an app failure: do not retry; fix the host or AVD audio setup.",
    retryable: false,
  };
}

export type AudioInputDiagnosticResolver = (
  device: BootedDevice,
) => AudioInputDiagnostic | undefined;

/**
 * Resolves the diagnostic for a booted device. An iOS simulator records from the host's default
 * input, so it reads the live (cached) host probe rather than an inventory captured at discovery.
 * An Android emulator uses the inventory its AVD config produced. Physical devices have their own
 * microphones and never get the diagnostic.
 */
export function createAudioInputDiagnosticResolver(
  hostAudio: () => HostAudioSnapshot = hostAudioSnapshot,
): AudioInputDiagnosticResolver {
  return (device) => {
    if (device.platform === "ios") {
      return resolveIosDeviceKind({ deviceId: device.deviceId }) === "simulator"
        ? audioInputDiagnosticFromCapabilities(iosSimulatorAudioCapabilities(hostAudio()))
        : undefined;
    }
    return audioInputDiagnosticFromCapabilities(device.capabilityInventory?.capabilities ?? []);
  };
}

export const defaultAudioInputDiagnostic: AudioInputDiagnosticResolver =
  createAudioInputDiagnosticResolver();
