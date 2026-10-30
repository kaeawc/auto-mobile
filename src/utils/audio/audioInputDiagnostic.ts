import type { BootedDevice } from "../../models";
import {
  AUDIO_INPUT_UNAVAILABLE,
  type AudioInputDiagnostic,
} from "../../models/AudioInputDiagnostic";
import type {
  VirtualDeviceCapability,
  VirtualDeviceCapabilityInventory,
} from "../../models/virtualDeviceCapabilities";
import { errorMessage } from "../../models/describeUnknownError";
import { isAndroidEmulatorSerial } from "../androidSerial";
import {
  FileAvdConfigReader,
  type AvdConfigReader,
} from "../android-cmdline-tools/AvdConfigReader";
import { logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import { defaultTimer, type Timer } from "../SystemTimer";
import { AMBIENT_ENV, readEnvRaw } from "../../config/env";
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
) => Promise<AudioInputDiagnostic | undefined>;

/**
 * Resolves the diagnostic for a booted device. An iOS simulator records from the host's default
 * input, so it reads the live (cached) host probe rather than an inventory captured at discovery.
 * An Android emulator uses its inventory, read from its AVD config when the device arrives without
 * one (the daemon session path builds a bare device). Physical devices have their own microphones
 * and never get the diagnostic.
 */
export function createAudioInputDiagnosticResolver(
  hostAudio: () => HostAudioSnapshot = hostAudioSnapshot,
  avdConfigs: AvdConfigReader = defaultAvdConfigs(),
  timer: DeadlineTimer = defaultTimer,
): AudioInputDiagnosticResolver {
  return async (device) => {
    if (device.platform === "ios") {
      return resolveIosDeviceKind({ deviceId: device.deviceId }) === "simulator"
        ? audioInputDiagnosticFromCapabilities(iosSimulatorAudioCapabilities(hostAudio()))
        : undefined;
    }
    const inventory =
      device.capabilityInventory ?? (await emulatorInventory(device, avdConfigs, timer));
    return audioInputDiagnosticFromCapabilities(inventory?.capabilities ?? []);
  };
}

type DeadlineTimer = Pick<Timer, "setTimeout" | "clearTimeout">;

const NO_AVD_CONFIGS: AvdConfigReader = { readConfig: async () => null };

/** Under `bun test` (NODE_ENV=test) the default never reads the machine's AVDs; tests inject one. */
function defaultAvdConfigs(): AvdConfigReader {
  return readEnvRaw(AMBIENT_ENV.NODE_ENV) === "test" ? NO_AVD_CONFIGS : new FileAvdConfigReader();
}

/** observe awaits the diagnostic, so a stalled config read must not hold the captured result. */
export const AVD_CONFIG_READ_TIMEOUT_MS = 1000;

async function emulatorInventory(
  device: BootedDevice,
  avdConfigs: AvdConfigReader,
  timer: DeadlineTimer,
): Promise<VirtualDeviceCapabilityInventory | undefined> {
  if (!isAndroidEmulatorSerial(device.deviceId)) {
    return undefined;
  }
  try {
    const config = await raceWithDeadline(() => avdConfigs.readConfig(device.name), {
      timer,
      timeoutMs: AVD_CONFIG_READ_TIMEOUT_MS,
      unref: true,
      label: `AVD config read for ${device.name}`,
    });
    return config?.capabilityInventory;
  } catch (error) {
    // Best effort: an unreadable or stalled AVD config leaves audio input unknown, not unavailable.
    logger.debug(`AVD config for ${device.name} unreadable: ${errorMessage(error)}`);
    return undefined;
  }
}

export const defaultAudioInputDiagnostic: AudioInputDiagnosticResolver =
  createAudioInputDiagnosticResolver();
