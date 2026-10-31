import { FileDaemonHttpTokenStore, type DaemonHttpTokenStore } from "./daemonHttpToken";
import { createServer as createHttpServer } from "http";
import type { HttpListener } from "./daemonHttpIngress";
import { DeviceReadiness } from "./readiness/DeviceReadiness";
import {
  createDefaultBindingExclusion,
  type BindingExclusion,
} from "./sessionBroker/provisioning/exclusion";
import { IncumbentOwnerGuard } from "./incumbentOwnerGuard";
import { currentDaemonProcessGenerationToken } from "./processGeneration";
import {
  PidFileLiveDaemonSessionIdProvider,
  type LiveDaemonSessionIdProvider,
} from "./daemonFiles";
import { defaultDaemonStateWrites, type DaemonStateWrites } from "./daemonContext";
import type { ForeignCtrlProxyForwardEvidence } from "../features/observe/android/foreignCtrlProxyForwardEvidence";
import { DatabaseInitializer, DefaultDatabaseInitializer } from "../db/DatabaseInitializer";
import { DatabaseHealthProbe, DefaultDatabaseHealthProbe } from "../db/DatabaseHealthProbe";
import { StartupFailureTracker, DefaultStartupFailureTracker } from "./DaemonStartupFailureTracker";
import type { InstalledAppsStore } from "../db/installedAppsRepository";
import {
  DeviceSessionRepository,
  type DeviceSessionPersistence,
} from "../db/deviceSessionRepository";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { IdGenerator, defaultIdGenerator } from "../utils/IdGenerator";
import { AvdManagerService } from "../utils/android-cmdline-tools/AvdManagerService";
import type { AvdManager } from "../utils/android-cmdline-tools/interfaces/AvdManager";
import { stopManagedAdbServer } from "../utils/android-cmdline-tools/AdbServerLifecycle";
import {
  defaultToolSelectionProfileRegistry,
  type ToolSelectionProfileProvenanceLoader,
} from "./toolSelectionProfileRegistry";

export type DaemonProcessBirthTimeProvider = () => number;
export type DaemonProcessGenerationTokenProvider = () => string | undefined;
export type DatabaseHealthFailureRecovery = (code: number, detail?: string) => void | Promise<void>;
export type ManagedAdbServerShutdown = () => Promise<void>;

/**
 * Injectable collaborators of `Daemon`. Every field is optional and defaults to the
 * production implementation; tests pass fakes by name instead of by position.
 */
/** The session store the daemon drives: persistence plus its startup expiry and autolock stamps. */
export type DaemonDeviceSessionStore = DeviceSessionPersistence &
  Pick<DeviceSessionRepository, "markAutolockSession" | "markStaleActiveSessionsExpired">;

export interface DaemonDependencies {
  deviceReadiness?: DeviceReadiness;
  installedAppsRepository?: InstalledAppsStore;
  timer?: Timer;
  deviceSessionRepository?: DaemonDeviceSessionStore;
  idGenerator?: IdGenerator;
  databaseInitializer?: DatabaseInitializer;
  startupFailureTracker?: StartupFailureTracker;
  databaseHealthProbe?: DatabaseHealthProbe;
  recoverFromDatabaseHealthFailure?: DatabaseHealthFailureRecovery;
  recoveryPolicyEnvironment?: NodeJS.ProcessEnv;
  managedAdbServerShutdown?: ManagedAdbServerShutdown;
  toolSelectionProfileProvenanceLoader?: ToolSelectionProfileProvenanceLoader;
  httpToken?: string;
  httpTokenStore?: DaemonHttpTokenStore;
  httpServerFactory?: () => HttpListener;
  processBirthTime?: DaemonProcessBirthTimeProvider;
  processGenerationToken?: DaemonProcessGenerationTokenProvider;
  liveDaemonSessionIdProvider?: LiveDaemonSessionIdProvider;
  incumbentOwnerGuard?: IncumbentOwnerGuard;
  avdManagerFactory?: () => Pick<AvdManager, "listDeviceImages">;
  /** The readiness service iOS startup warm-up verifies simulators through. */
  iosDeviceVerifier?: () => Pick<DeviceReadiness, "verifyIosDevice">;
  /** Managed-binding exclusion for the pool (#11174); defaults to the host-wide SQLite registry. */
  bindingExclusionFactory?: (timer: Timer) => BindingExclusion;
  /** Host forward evidence is supplied by the production entry point only (#12220). */
  foreignCtrlProxyForwardEvidence?: ForeignCtrlProxyForwardEvidence;
  /**
   * Whether host disk I/O is stalled, which excuses database health-probe timeouts (#11990).
   * Defaults to the process-wide log sink's stall evidence; tests inject a fixed answer so a
   * stall reported by an unrelated file cannot decide their strike count.
   */
  hostIoStalled?: () => boolean;
  /** Where the daemon registers its sessions and pool; defaults to the process-wide state. */
  daemonState?: DaemonStateWrites;
}

/** {@link DaemonDependencies} with every default applied; the three optional ones stay optional. */
export type ResolvedDaemonDependencies = Required<
  Omit<
    DaemonDependencies,
    | "installedAppsRepository"
    | "recoverFromDatabaseHealthFailure"
    | "foreignCtrlProxyForwardEvidence"
    | "hostIoStalled"
  >
> &
  Pick<
    DaemonDependencies,
    | "installedAppsRepository"
    | "recoverFromDatabaseHealthFailure"
    | "foreignCtrlProxyForwardEvidence"
    | "hostIoStalled"
  >;

/**
 * Captures a wall-clock approximation of this OS process's birth time, rather
 * than the later point at which daemon bootstrap constructs its generation.
 * `process.uptime()` is rooted at process creation, so it remains comparable to
 * the process-table birth timestamps read by DaemonManager.
 */
function defaultDaemonProcessBirthTime(): number {
  return Date.now() - Math.max(0, process.uptime() * 1_000);
}

function resolveStores(dependencies: DaemonDependencies, timer: Timer) {
  return {
    deviceSessionRepository:
      dependencies.deviceSessionRepository ?? new DeviceSessionRepository({ timer }),
    idGenerator: dependencies.idGenerator ?? defaultIdGenerator,
    databaseInitializer: dependencies.databaseInitializer ?? new DefaultDatabaseInitializer(),
    startupFailureTracker: dependencies.startupFailureTracker ?? new DefaultStartupFailureTracker(),
    databaseHealthProbe:
      dependencies.databaseHealthProbe ?? new DefaultDatabaseHealthProbe({ timer }),
  };
}

function resolveProcessIdentity(dependencies: DaemonDependencies) {
  return {
    recoveryPolicyEnvironment: dependencies.recoveryPolicyEnvironment ?? process.env,
    processBirthTime: dependencies.processBirthTime ?? defaultDaemonProcessBirthTime,
    processGenerationToken:
      dependencies.processGenerationToken ?? currentDaemonProcessGenerationToken,
    liveDaemonSessionIdProvider:
      dependencies.liveDaemonSessionIdProvider ?? new PidFileLiveDaemonSessionIdProvider(),
    incumbentOwnerGuard: dependencies.incumbentOwnerGuard ?? new IncumbentOwnerGuard(),
  };
}

function resolveFactories(dependencies: DaemonDependencies) {
  const deviceReadiness = dependencies.deviceReadiness ?? DeviceReadiness.createInstance();
  return {
    managedAdbServerShutdown: dependencies.managedAdbServerShutdown ?? stopManagedAdbServer,
    toolSelectionProfileProvenanceLoader:
      dependencies.toolSelectionProfileProvenanceLoader ?? defaultToolSelectionProfileRegistry,
    httpToken: dependencies.httpToken ?? "",
    httpTokenStore: dependencies.httpTokenStore ?? new FileDaemonHttpTokenStore(),
    httpServerFactory: dependencies.httpServerFactory ?? (() => createHttpServer()),
    avdManagerFactory: dependencies.avdManagerFactory ?? (() => new AvdManagerService()),
    deviceReadiness,
    iosDeviceVerifier: dependencies.iosDeviceVerifier ?? (() => deviceReadiness),
    bindingExclusionFactory: dependencies.bindingExclusionFactory ?? createDefaultBindingExclusion,
    daemonState: dependencies.daemonState ?? defaultDaemonStateWrites,
  };
}

export function resolveDaemonDependencies(
  dependencies: DaemonDependencies,
): ResolvedDaemonDependencies {
  const timer = dependencies.timer ?? defaultTimer;
  return {
    ...dependencies,
    timer,
    ...resolveStores(dependencies, timer),
    ...resolveProcessIdentity(dependencies),
    ...resolveFactories(dependencies),
  };
}
