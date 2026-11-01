import type { VirtualDeviceCapability } from "../../models/virtualDeviceCapabilities";
import type { HostAudioDevice, HostAudioSnapshot } from "./hostAudio";

function describeDevice(device: HostAudioDevice): string {
  return `${device.name ?? "unnamed device"} (${device.transport.replace("_", "-")})`;
}

const NO_INPUT_REASON =
  "No host audio input device; install a virtual loopback device and make it the default input.";

/**
 * Audio entries for an iOS simulator, from the host's CoreAudio defaults (#13626): the simulator
 * routes microphone input to the host's default input and plays through its default output. Empty
 * when the host was not probed, so the inventory never over-claims.
 */
export function iosSimulatorAudioCapabilities(host: HostAudioSnapshot): VirtualDeviceCapability[] {
  if (!host.probed) {
    return [];
  }
  const input: VirtualDeviceCapability = host.input
    ? {
        id: "ios.simulator.audioInput",
        state: "available",
        source: "host_audio",
        reason: `Host default input: ${describeDevice(host.input)}.`,
      }
    : {
        id: "ios.simulator.audioInput",
        state: "unsupported",
        source: "host_audio",
        reason: NO_INPUT_REASON,
      };
  const output: VirtualDeviceCapability = host.output
    ? {
        id: "ios.simulator.audioOutput",
        state: "available",
        source: "host_audio",
        reason: `Host default output: ${describeDevice(host.output)}.`,
      }
    : {
        id: "ios.simulator.audioOutput",
        state: "unsupported",
        source: "host_audio",
        reason: "No host audio output device.",
      };
  const capture: VirtualDeviceCapability = host.outputCaptureable
    ? {
        id: "ios.simulator.audioOutputCapture",
        state: "available",
        source: "host_audio",
        reason: `The default output is a loopback device whose signal can be read back: ${describeDevice(host.output as HostAudioDevice)}.`,
      }
    : {
        id: "ios.simulator.audioOutputCapture",
        state: "unsupported",
        source: "host_audio",
        reason: host.output
          ? "The default output is not a loopback or virtual device, so its signal cannot be read back; install one and make it the default output."
          : "No host audio output device.",
      };
  return [input, output, capture];
}

const ENABLED = new Set(["1", "true", "yes"]);
const DISABLED = new Set(["0", "false", "no", "none", "off"]);

function configured(value: string | undefined): "on" | "off" | "unset" {
  const normalized = value?.trim().toLowerCase();
  if (normalized !== undefined && DISABLED.has(normalized)) {
    return "off";
  }
  return normalized !== undefined && ENABLED.has(normalized) ? "on" : "unset";
}

export interface AndroidAudioInputs {
  config: Readonly<Record<string, string | undefined>>;
  /** The emulator is launched with `-no-audio` (AUTOMOBILE_EMULATOR_AUDIO=false). */
  launchWithoutAudio: boolean;
  host: HostAudioSnapshot;
  grpc?:
    | { state: "reachable" }
    | { state: "unreachable"; reason: string }
    | { state: "not_configured"; reason?: string };
}

export function androidGrpcAudioCapabilities(
  grpc: AndroidAudioInputs["grpc"],
): VirtualDeviceCapability[] {
  if (!grpc) {
    return [];
  }
  return ["android.emulator.audioInputInjection", "android.emulator.audioOutputCapture"].map(
    (id): VirtualDeviceCapability => {
      if (grpc.state === "reachable") {
        return { id, state: "available", source: "platform" };
      }
      const fallback =
        grpc.state === "unreachable"
          ? "The emulator gRPC endpoint is unreachable."
          : "No emulator gRPC port is configured.";
      return {
        id,
        state: grpc.state === "unreachable" ? "unavailable" : "unsupported",
        source: "platform",
        reason: grpc.reason?.trim() ? grpc.reason : fallback,
      };
    },
  );
}

/**
 * Audio entries for an Android emulator: `hw.audioInput` / `hw.audioOutput` from its AVD config,
 * `-no-audio` at launch, and for input the host having an input source. A key the config does not
 * state is left out unless `-no-audio` settles it.
 */
export function androidEmulatorAudioCapabilities(
  inputs: AndroidAudioInputs,
): VirtualDeviceCapability[] {
  const found: VirtualDeviceCapability[] = [];
  const noAudio = "The emulator is launched with -no-audio (AUTOMOBILE_EMULATOR_AUDIO=false).";
  const directions = [
    { id: "android.emulator.audioInput", key: "hw.audioInput", label: "input" },
    { id: "android.emulator.audioOutput", key: "hw.audioOutput", label: "output" },
  ] as const;
  for (const { id, key, label } of directions) {
    const value = configured(inputs.config[key]);
    if (inputs.launchWithoutAudio) {
      found.push({ id, state: "unsupported", source: "platform", reason: noAudio });
    } else if (value === "off") {
      found.push({
        id,
        state: "unsupported",
        source: "avd_config",
        reason: `The AVD has ${key}=no; set it to yes to enable audio ${label}.`,
      });
    } else if (value === "on" && label === "input" && inputs.host.probed && !inputs.host.input) {
      found.push({ id, state: "unsupported", source: "host_audio", reason: NO_INPUT_REASON });
    } else if (value === "on") {
      found.push({ id, state: "available", source: "avd_config" });
    }
  }
  found.push(...androidGrpcAudioCapabilities(inputs.grpc));
  return found;
}
