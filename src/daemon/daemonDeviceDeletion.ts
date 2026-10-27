import type {
  TeardownDeviceArgs,
  TeardownToolResponse,
} from "../features/deviceLifecycle/deviceLifecycleCore";

/** Runs the verified `deleteDevice` workflow (stop, destroy, verify absence) on the daemon's behalf. */
export type DaemonDeviceDeletion = (
  args: TeardownDeviceArgs,
  signal?: AbortSignal,
) => Promise<TeardownToolResponse>;

let daemonDeviceDeletion: DaemonDeviceDeletion | undefined;

/** The daemon's delete workflow, once the server's device tools are registered in this process. */
export function getDaemonDeviceDeletion(): DaemonDeviceDeletion | undefined {
  return daemonDeviceDeletion;
}

/** Wired by the server's device-tool registration, which owns the workflow's dependencies. */
export function registerDaemonDeviceDeletion(deletion: DaemonDeviceDeletion): void {
  daemonDeviceDeletion = deletion;
}
