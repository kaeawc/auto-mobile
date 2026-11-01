import { connect } from "node:net";
import { errorMessage } from "../../models/describeUnknownError";
import { logger } from "../logger";
import { raceWithDeadline } from "../raceWithDeadline";
import { defaultTimer, type Timer } from "../SystemTimer";
import type { AndroidAudioInputs } from "./audioCapabilities";

export type GrpcReachabilityState = Exclude<
  NonNullable<AndroidAudioInputs["grpc"]>,
  { state: "not_configured" }
>;
type ProbeTimer = Pick<Timer, "setTimeout" | "clearTimeout">;

export interface EmulatorGrpcReachability {
  connect(address: string, deadlineMs: number): Promise<GrpcReachabilityState>;
}

export interface GrpcProbeConnection {
  once(event: "connect", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  destroy(): unknown;
}

/** TCP reachability only: this does not verify gRPC authentication (invalid JWT, #16026). */
export class NetEmulatorGrpcReachability implements EmulatorGrpcReachability {
  constructor(
    private readonly timer: ProbeTimer = defaultTimer,
    private readonly open: (port: number, host: string) => GrpcProbeConnection = connect,
  ) {}

  async connect(address: string, deadlineMs: number): Promise<GrpcReachabilityState> {
    let socket: GrpcProbeConnection | undefined;
    try {
      const url = new URL(`http://${address}`);
      await raceWithDeadline(
        () =>
          new Promise<void>((resolve, reject) => {
            socket = this.open(Number(url.port || "80"), url.hostname.replace(/^\[|\]$/g, ""));
            socket.once("connect", resolve);
            socket.once("error", reject);
          }),
        {
          timer: this.timer,
          timeoutMs: deadlineMs,
          unref: true,
          label: `Emulator gRPC endpoint ${address}`,
        },
      );
      return { state: "reachable" };
    } catch (error) {
      // Refused or stalled endpoints are expected during emulator startup and shutdown.
      logger.debug(`Emulator gRPC probe ${address} failed: ${errorMessage(error)}`);
      return {
        state: "unreachable",
        reason: `The emulator gRPC endpoint ${address} did not accept a connection: ${errorMessage(error)}`,
      };
    } finally {
      socket?.destroy();
    }
  }
}
