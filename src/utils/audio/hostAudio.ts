/**
 * Host audio availability (#13626). The iOS Simulator routes simulated microphone input to the
 * host's default CoreAudio input, and an Android emulator uses the host's audio devices, so whether
 * the host has a usable default input or output decides whether a virtual device can record or
 * play. The answer comes from CoreAudio HAL property queries, which work without a GUI session
 * (a LaunchDaemon service user, an SSH session), never from system_profiler.
 */

export type HostAudioTransport =
  | "built_in"
  | "virtual"
  | "usb"
  | "bluetooth"
  | "aggregate"
  | "hdmi"
  | "displayport"
  | "thunderbolt"
  | "pci"
  | "firewire"
  | "airplay"
  | "continuity"
  | "unknown";

export interface HostAudioDevice {
  /** The device's localized name, or null when the HAL did not report one. */
  name: string | null;
  transport: HostAudioTransport;
  inputStreams: number;
  outputStreams: number;
}

export interface HostAudioSnapshot {
  platform: NodeJS.Platform;
  /** False when this host has no audio probe (not macOS, or the HAL could not be read). */
  probed: boolean;
  /** Why nothing was probed. */
  reason?: string;
  /** The default input device when it has at least one input stream, else null. */
  input: HostAudioDevice | null;
  /** The default output device when it has at least one output stream, else null. */
  output: HostAudioDevice | null;
  /** The default output is a virtual or loopback device whose signal can be read back (#13629). */
  outputCaptureable: boolean;
}

/** One device as the HAL reports it, before interpretation. */
export interface RawAudioDevice {
  name?: string;
  /** The transport type four-character code, such as `bltn` or `virt`. */
  transportCode?: string;
  inputStreams: number;
  outputStreams: number;
}

/** The HAL surface the probe needs; the CoreAudio binding implements it, tests fake it. */
export interface CoreAudioHal {
  /** The system default device id for a direction, or undefined when there is none. */
  defaultDeviceId(direction: "input" | "output"): number | undefined;
  describe(deviceId: number): RawAudioDevice | undefined;
}

const TRANSPORTS: Record<string, HostAudioTransport> = {
  bltn: "built_in",
  virt: "virtual",
  "usb ": "usb",
  blue: "bluetooth",
  blea: "bluetooth",
  grup: "aggregate",
  hdmi: "hdmi",
  dprt: "displayport",
  thun: "thunderbolt",
  "pci ": "pci",
  "1394": "firewire",
  airp: "airplay",
  cont: "continuity",
};

export function hostAudioTransport(code: string | undefined): HostAudioTransport {
  return (code && TRANSPORTS[code]) || "unknown";
}

/** Loopback drivers that report a non-virtual transport but exist to read the output back. */
const LOOPBACK_NAME = /blackhole|loopback|soundflower|vb-?cable|background music/i;

function toDevice(raw: RawAudioDevice): HostAudioDevice {
  return {
    name: raw.name ?? null,
    transport: hostAudioTransport(raw.transportCode),
    inputStreams: raw.inputStreams,
    outputStreams: raw.outputStreams,
  };
}

function usable(device: HostAudioDevice | undefined, direction: "input" | "output") {
  const streams = direction === "input" ? device?.inputStreams : device?.outputStreams;
  return device && (streams ?? 0) > 0 ? device : null;
}

export function isCaptureableOutput(device: HostAudioDevice | null): boolean {
  return (
    device !== null &&
    (device.transport === "virtual" || (device.name !== null && LOOPBACK_NAME.test(device.name)))
  );
}

/** Query the HAL for the current defaults. Pure over the injected [hal]. */
export function readHostAudio(hal: CoreAudioHal, platform: NodeJS.Platform): HostAudioSnapshot {
  const read = (direction: "input" | "output") => {
    const id = hal.defaultDeviceId(direction);
    const raw = id === undefined ? undefined : hal.describe(id);
    return usable(raw && toDevice(raw), direction);
  };
  const input = read("input");
  const output = read("output");
  return { platform, probed: true, input, output, outputCaptureable: isCaptureableOutput(output) };
}

export function unprobedHostAudio(platform: NodeJS.Platform, reason: string): HostAudioSnapshot {
  return { platform, probed: false, reason, input: null, output: null, outputCaptureable: false };
}

/**
 * Caches the host audio answer for the daemon's lifetime. A HAL plug-in install or a
 * default-device change alters the answer, so each read compares the two default device ids (one
 * cheap HAL query each) and re-probes when either moved; [refresh] forces a re-probe.
 */
export class HostAudioProbe {
  private cached: { snapshot: HostAudioSnapshot; ids: string } | undefined;

  constructor(
    private readonly hal: CoreAudioHal | undefined,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly unavailableReason = "No host audio probe on this platform.",
  ) {}

  snapshot(): HostAudioSnapshot {
    const hal = this.hal;
    if (!hal) {
      return unprobedHostAudio(this.platform, this.unavailableReason);
    }
    const ids = `${hal.defaultDeviceId("input")}/${hal.defaultDeviceId("output")}`;
    if (this.cached?.ids !== ids) {
      this.cached = { snapshot: readHostAudio(hal, this.platform), ids };
    }
    return this.cached.snapshot;
  }

  refresh(): HostAudioSnapshot {
    this.cached = undefined;
    return this.snapshot();
  }
}
