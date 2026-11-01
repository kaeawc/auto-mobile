import type { HostChildProcess as ChildProcess } from "../../HostCommandExecutor";
import type { EmulatorGrpcPortLease, EmulatorPortReservations } from "../EmulatorPortReservations";
import { hasEmulatorGrpcArgument } from "./emulatorGrpcPorts";

/**
 * Without `-grpc` the emulator advertises no gRPC endpoint, so audio tools cannot reach it. A
 * caller-supplied `-grpc` wins; otherwise a free host port is leased and appended to `args`.
 */
export async function leaseEmulatorGrpcPort(
  args: string[],
  reservations: Pick<EmulatorPortReservations, "reserveEmulatorGrpcPort">,
): Promise<EmulatorGrpcPortLease | undefined> {
  if (hasEmulatorGrpcArgument(args)) {
    return undefined;
  }
  const lease = await reservations.reserveEmulatorGrpcPort();
  args.push("-grpc", String(lease.port));
  return lease;
}

/**
 * A running emulator binds its gRPC port for as long as it runs, so its child keeps the lease
 * until the launch reservation is released on exit. No running child means nothing holds the
 * port, so the lease is released now.
 */
export function handOffEmulatorGrpcLease(
  lease: EmulatorGrpcPortLease | undefined,
  child: ChildProcess | null,
  reservations: Pick<EmulatorPortReservations, "trackEmulatorGrpcLease">,
): void {
  if (!lease) {
    return;
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    reservations.trackEmulatorGrpcLease(child, lease);
  } else {
    lease.release();
  }
}
