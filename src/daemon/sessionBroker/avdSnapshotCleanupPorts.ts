import { ProcessTableReader } from "../../devices/bootAdmission/processTableRetry";
import { nodeProcFs } from "../../devices/bootAdmission/procProcessTable";
import { DefaultHostCommandExecutor } from "../../utils/HostCommandExecutor";
import { FileAvdConfigReader } from "../../utils/android-cmdline-tools/AvdConfigReader";
import { AndroidEmulatorClient } from "../../utils/android-cmdline-tools/AndroidEmulatorClient";
import type { Timer } from "../../utils/SystemTimer";
import {
  nodeAvdSnapshotCleanupFilesystem,
  type cleanupAvdSnapshots,
  type AvdSnapshotCleanupRegistry,
} from "./AvdSnapshotCleanup";
import { ProcessTableAvdSnapshotCleanupLiveness } from "./avdSnapshotCleanupLiveness";

export type BrokerAvdSnapshotCleanupPorts = Parameters<typeof cleanupAvdSnapshots>[1];

/** Construction performs no discovery, filesystem reads, or database opens. */
export function nativeAvdSnapshotCleanupPorts(
  registry: AvdSnapshotCleanupRegistry | undefined,
  timer?: Timer,
): BrokerAvdSnapshotCleanupPorts {
  const emulator = new AndroidEmulatorClient();
  return {
    registry,
    resolver: new FileAvdConfigReader(),
    filesystem: nodeAvdSnapshotCleanupFilesystem,
    liveness: new ProcessTableAvdSnapshotCleanupLiveness(
      new ProcessTableReader(new DefaultHostCommandExecutor(), { timer, procFs: nodeProcFs }),
      () => emulator.getBootedDevicesChecked(true),
    ),
  };
}

export function resolveAvdSnapshotCleanupPorts(
  ports: BrokerAvdSnapshotCleanupPorts | undefined,
  registry?: { avdSnapshotCleanupRegistry(): AvdSnapshotCleanupRegistry },
  timer?: Timer,
): BrokerAvdSnapshotCleanupPorts {
  return ports ?? nativeAvdSnapshotCleanupPorts(registry?.avdSnapshotCleanupRegistry(), timer);
}
