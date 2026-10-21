import type { DatabaseHealthProbe } from "../../db/DatabaseHealthProbe";
import type { DatabaseInitializer } from "../../db/DatabaseInitializer";
import type { StartupFailureTracker } from "../DaemonStartupFailureTracker";
import type { DatabaseHealthFailureRecovery } from "../daemonDependencies";
import type { ToolSelectionProfileProvenanceLoader } from "../toolSelectionProfileRegistry";

/** When and as which OS process this daemon generation started; fixed at construction. */
export interface DaemonProcessIdentity {
  readonly generationStartedAt: number;
  readonly processStartedAt: number;
  readonly processGenerationToken: string | undefined;
  readonly liveAcceptanceStartupSecret: string | undefined;
}

/** Database startup and health collaborators resolved from `DaemonDependencies`. */
export interface DaemonDatabaseServices {
  readonly databaseInitializer: DatabaseInitializer;
  readonly toolSelectionProfileProvenanceLoader: ToolSelectionProfileProvenanceLoader;
  readonly databaseHealthProbe: DatabaseHealthProbe;
  readonly startupFailureTracker: StartupFailureTracker;
  readonly recoverFromDatabaseHealthFailure: DatabaseHealthFailureRecovery;
}
