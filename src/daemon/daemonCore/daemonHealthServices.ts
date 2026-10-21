import { exitAfterDatabaseHealthFailure } from "../databaseHealthExit";
import { cleanupDaemonFilesSync } from "../daemonFiles";
import { writeEmergencyLog } from "../../utils/loggingConfig";
import { logger } from "../../utils/logger";
import { DefaultObservationStreamHealth } from "../ObservationStreamHealth";
import {
  getDeviceDataStreamServer,
  stopDeviceDataStreamSocketServer,
  startDeviceDataStreamSocketServer,
} from "../deviceDataStreamSocketServer";
import type { DaemonCoreServices, DaemonLifecycleState } from "./DaemonCoreState";
import type { DaemonIdentity } from "./DaemonIdentity";
import type { DaemonStreams } from "./DaemonStreams";
import type { DatabaseHealthFailureRecovery } from "../daemonDependencies";

export function createDatabaseHealthFailureRecovery(host: {
  timer: DaemonCoreServices["timer"];
  selfExitRecorder: DaemonLifecycleState["selfExitRecorder"];
  getDaemonFileCleanupOptions: DaemonIdentity["getDaemonFileCleanupOptions"];
}): DatabaseHealthFailureRecovery {
  return (code, detail) =>
    exitAfterDatabaseHealthFailure(code, detail, {
      now: () => host.timer().now(),
      writeEmergency: (message) => writeEmergencyLog(message),
      writeExitRecord: () => host.selfExitRecorder().record("database-health"),
      cleanupDaemonFiles: () => {
        cleanupDaemonFilesSync(host.getDaemonFileCleanupOptions());
      },
      closeLogger: () => logger.closeAfterFlush(),
      exit: (exitCode) => process.exit(exitCode),
    });
}

export function createObservationStreamHealth(host: {
  timer: DaemonCoreServices["timer"];
  startAuxiliarySocket: DaemonIdentity["startAuxiliarySocket"];
  configureDeviceDataStreamServer: DaemonStreams["configureDeviceDataStreamServer"];
}): DefaultObservationStreamHealth {
  return new DefaultObservationStreamHealth({
    getServer: getDeviceDataStreamServer,
    stopServer: stopDeviceDataStreamSocketServer,
    startServer: async () => {
      await host.startAuxiliarySocket("observation-stream", () =>
        startDeviceDataStreamSocketServer(host.timer()),
      );
    },
    configureCallbacks: () => host.configureDeviceDataStreamServer(),
  });
}
