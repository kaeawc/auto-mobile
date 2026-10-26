import type { DeviceStartOptions } from "./deviceDiscoveryContracts";

/** Launch arguments for the exit-snapshot policy (#15477). */
export function snapshotLaunchArguments(options: DeviceStartOptions): {
  extraArgs?: readonly string[];
} {
  return options.discardSnapshotOnExit ? { extraArgs: ["-no-snapshot-save"] } : {};
}
