import type { DaemonClientFactory } from "./client";
import type { DaemonStateLike } from "./daemonState";
import type { DaemonSocketReachabilityLike } from "./daemonSocketReachability";
import type { DaemonLauncher, DaemonLaunchCommand, DaemonProcessSpawner } from "./DaemonLauncher";
import type { IdentityRecoveryIO } from "./identityRecovery";
import type { DaemonPortAvailabilityChecker } from "./portAvailability";
import type { DaemonProcessFinder, DaemonProcessSignaler } from "./processTable";
import type { ExtractionCleaner } from "./manager";
import type { LockOwnerGenerationProbe } from "../utils/fileLock";
import type { RetryExecutor } from "../utils/retry/RetryExecutor";
import type { IdGenerator } from "../utils/IdGenerator";
import type { Timer } from "../utils/SystemTimer";

/**
 * Injectable collaborators and paths of `DaemonManager`. Every field is optional
 * and defaults to the production implementation; tests pass fakes by name.
 */
export interface DaemonManagerOptions {
  clientFactory?: DaemonClientFactory;
  stateProvider?: () => DaemonStateLike;
  timer?: Timer;
  lockFilePath?: string;
  pidFilePath?: string;
  socketPath?: string;
  processFinder?: DaemonProcessFinder;
  processSpawner?: DaemonProcessSpawner;
  extractionCleaner?: ExtractionCleaner;
  launcher?: DaemonLauncher;
  launchCommandResolver?: () => DaemonLaunchCommand;
  processSignaler?: DaemonProcessSignaler;
  idGenerator?: IdGenerator;
  peerSocketReachability?: DaemonSocketReachabilityLike;
  platform?: NodeJS.Platform;
  portAvailabilityChecker?: DaemonPortAvailabilityChecker;
  retryExecutor?: RetryExecutor;
  daemonProtocolHealthProbe?: () => Promise<boolean>;
  identityRecoveryIO?: IdentityRecoveryIO;
  lockOwnerGenerationProbe?: LockOwnerGenerationProbe;
}
