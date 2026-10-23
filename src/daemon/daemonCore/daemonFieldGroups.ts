import type { AvdManager } from "../../utils/android-cmdline-tools/interfaces/AvdManager";
import type { ForeignCtrlProxyForwardEvidence } from "../../features/observe/android/foreignCtrlProxyForwardEvidence";
import type { Timer } from "../../utils/SystemTimer";
import type { HttpListener } from "../daemonHttpIngress";
import type { LiveDaemonSessionIdProvider } from "../daemonFiles";
import type { DeviceReadiness } from "../readiness/DeviceReadiness";
import type { BindingExclusion } from "../sessionBroker/provisioning/exclusion";
import type { DatabaseHealthProbe } from "../../db/DatabaseHealthProbe";
import type { DatabaseInitializer } from "../../db/DatabaseInitializer";
import type { StartupFailureTracker } from "../DaemonStartupFailureTracker";
import type {
  DatabaseHealthFailureRecovery,
  ManagedAdbServerShutdown,
} from "../daemonDependencies";
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

/** Replaceable seams resolved from `DaemonDependencies`; fixed at construction. */
export interface DaemonInjectedServices {
  readonly httpServerFactory: () => HttpListener;
  readonly liveDaemonSessionIdProvider: LiveDaemonSessionIdProvider;
  readonly avdManagerFactory: () => Pick<AvdManager, "listDeviceImages">;
  readonly iosDeviceVerifier: () => Pick<DeviceReadiness, "verifyIosDevice">;
  readonly bindingExclusionFactory: (timer: Timer) => BindingExclusion;
  readonly foreignCtrlProxyForwardEvidence?: ForeignCtrlProxyForwardEvidence;
  readonly stopManagedAdbServer: ManagedAdbServerShutdown;
}

/** Where this daemon listens and how it logs; `port` changes when a free port is chosen. */
export interface DaemonListenConfig {
  port: number;
  host: string;
  readonly strictPort: boolean;
  debug: boolean;
}

/** Settles once startup finishes or fails; created before anything can await it. */
export interface DaemonStartupCompletion {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

export function createStartupCompletion(): DaemonStartupCompletion {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
