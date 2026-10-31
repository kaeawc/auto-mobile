import {
  NetEmulatorGrpcReachability,
  type EmulatorGrpcReachability,
} from "./emulatorGrpcReachability";
import { AMBIENT_ENV, readEnvRaw } from "../../config/env";
import { errorMessage } from "../../models/describeUnknownError";
import { isAndroidEmulatorSerial } from "../androidSerial";
import {
  FileEmulatorGrpcDiscovery,
  type EmulatorGrpcDiscovery,
} from "../android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";
import { SingleFlight } from "../cache/SingleFlight";
import { DefaultFileSystem } from "../filesystem/DefaultFileSystem";
import { logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import { defaultTimer, type Timer } from "../SystemTimer";
import type { AndroidAudioInputs } from "./audioCapabilities";

type GrpcAudioState = NonNullable<AndroidAudioInputs["grpc"]>;
type ProbeTimer = Pick<Timer, "now" | "setTimeout" | "clearTimeout">;

const TTL_MS = 30_000;
const PROBE_DEADLINE_MS = 500;

/** Synchronous last-known state; listing refreshes it without blocking device descriptions. */
export class EmulatorGrpcAudioState {
  private readonly cache = new Map<string, { state: GrpcAudioState; at: number }>();
  private readonly flight = new SingleFlight<string, void>();

  constructor(
    private readonly discovery: EmulatorGrpcDiscovery,
    private readonly reachability: EmulatorGrpcReachability,
    private readonly timer: ProbeTimer,
  ) {}

  snapshot(serial: string): AndroidAudioInputs["grpc"] {
    return this.cache.get(serial)?.state;
  }

  async refresh(serial: string): Promise<void> {
    if (!isAndroidEmulatorSerial(serial)) {
      return;
    }
    const cached = this.cache.get(serial);
    if (cached && this.timer.now() - cached.at < TTL_MS) {
      return;
    }
    await this.flight.run(serial, async () => {
      let state: GrpcAudioState;
      try {
        const endpoint = await raceWithDeadline(
          () => this.discovery.findByConsolePort(Number(serial.slice("emulator-".length))),
          {
            timer: this.timer,
            timeoutMs: PROBE_DEADLINE_MS,
            unref: true,
            label: `Emulator gRPC discovery for ${serial}`,
          },
        );
        state = endpoint
          ? await this.reachability.connect(endpoint.address, PROBE_DEADLINE_MS)
          : {
              state: "not_configured",
              reason: `No emulator gRPC endpoint is advertised for ${serial}.`,
            };
      } catch (error) {
        // Optional inventory enrichment must not prevent device listing.
        logger.warn(`Emulator gRPC discovery/probe for ${serial} failed: ${errorMessage(error)}`);
        state = {
          state: "unreachable",
          reason: `Emulator gRPC probe failed: ${errorMessage(error)}`,
        };
      }
      this.cache.set(serial, { state, at: this.timer.now() });
    });
  }
}

let override: EmulatorGrpcAudioState | undefined;
let production: EmulatorGrpcAudioState | undefined;
function currentState(): EmulatorGrpcAudioState | undefined {
  if (override) {
    return override;
  }
  // Default tests never read running AVD advertisements or open real sockets.
  if (readEnvRaw(AMBIENT_ENV.NODE_ENV) === "test") {
    return undefined;
  }
  production ??= new EmulatorGrpcAudioState(
    new FileEmulatorGrpcDiscovery(new DefaultFileSystem()),
    new NetEmulatorGrpcReachability(),
    defaultTimer,
  );
  return production;
}
export function emulatorGrpcAudioSnapshot(serial: string): AndroidAudioInputs["grpc"] {
  return currentState()?.snapshot(serial);
}
export async function refreshEmulatorGrpcAudio(serial: string): Promise<void> {
  await currentState()?.refresh(serial);
}
export function setEmulatorGrpcAudioStateForTesting(
  state: EmulatorGrpcAudioState | undefined,
): void {
  override = state;
}
