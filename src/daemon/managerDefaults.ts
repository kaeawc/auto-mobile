import { DaemonState } from "./daemonState";
import { LOCK_FILE_PATH, PID_FILE_PATH, SOCKET_PATH } from "./constants";
import { NetDaemonPortAvailabilityChecker } from "./portAvailability";
import { createDefaultDaemonProcessFinder } from "./processTable";
import { defaultLockOwnerGenerationProbe } from "./lockOwnerGeneration";
import type { DaemonManagerOptions } from "./managerOptions";
import { defaultIdGenerator } from "../utils/IdGenerator";
import { DefaultRetryExecutor } from "../utils/retry/RetryExecutor";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import type { DaemonProcessSignaler } from "./processTable";
import { resolveExtractionRootForEntryScript, type ExtractionCleaner } from "./extractionRoot";
import { rm } from "node:fs/promises";

export const defaultDaemonProcessSignaler: DaemonProcessSignaler = {
  signal(pid, signal): void {
    process.kill(pid, signal);
  },
};

export const fileSystemExtractionCleaner: ExtractionCleaner = {
  async removeExtractionForEntryScript(entryScript: string): Promise<boolean> {
    const extractionRoot = resolveExtractionRootForEntryScript(entryScript);
    if (!extractionRoot) {
      return false;
    }

    await rm(extractionRoot, { recursive: true, force: true });
    return true;
  },
};

/** The manager's ambient inputs: state, clock, file locations, platform and id source. */
export function resolveManagerEnvironment({
  stateProvider = () => DaemonState.getInstance(),
  timer = defaultTimer,
  lockFilePath = LOCK_FILE_PATH,
  pidFilePath = PID_FILE_PATH,
  socketPath = SOCKET_PATH,
  platform = process.platform,
  idGenerator = defaultIdGenerator,
}: DaemonManagerOptions) {
  return { stateProvider, timer, lockFilePath, pidFilePath, socketPath, platform, idGenerator };
}

/** The manager's host-facing collaborators, defaulting to the production implementations. */
export function resolveManagerServices(options: DaemonManagerOptions, timer: Timer) {
  const {
    processFinder = createDefaultDaemonProcessFinder(),
    extractionCleaner = fileSystemExtractionCleaner,
    processSignaler = defaultDaemonProcessSignaler,
    portAvailabilityChecker = new NetDaemonPortAvailabilityChecker(),
    retryExecutor = new DefaultRetryExecutor(timer),
    lockOwnerGenerationProbe = defaultLockOwnerGenerationProbe,
  } = options;
  return {
    processFinder,
    extractionCleaner,
    processSignaler,
    portAvailabilityChecker,
    retryExecutor,
    lockOwnerGenerationProbe,
  };
}
