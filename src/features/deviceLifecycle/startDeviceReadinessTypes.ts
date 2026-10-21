import type { BootedDevice } from "../../models";
import type { DevicePool, DeviceReadinessReservation } from "../../daemon/devicePool";
import type { SessionManager } from "../../daemon/sessionManager";
import type { PlatformDeviceManager } from "../../devices/deviceUtils";
import type { Timer } from "../../utils/SystemTimer";
import type { DeviceBootResult, DeviceBootService } from "../../devices/deviceBootService";
import type { createPerformanceTracker } from "../../utils/PerformanceTracker";
import type { RunnerReadinessRequest } from "../../ctrlProxy/RunnerReadinessService";
import type {
  ColdBootSettlementCollector,
  ProgressCallback,
  StartDeviceArgs,
} from "./deviceLifecycleCore";

/** The pool surface the runner-readiness path calls (reservation, holder lookup, release, autolock capture). */
export type ReadinessDevicePool = Pick<
  DevicePool,
  | "getDevice"
  | "releaseDevice"
  | "reserveDeviceForReadiness"
  | "reserveDeviceForShutdown"
  | "captureAutolockSessionForMcpSession"
  | "replaceDeviceForSystemUiAnrRecovery"
  | "retireDeviceAfterSystemUiAnrRecoveryFailure"
  | "noteLatePlatformShutdownSettled"
  | "markIntentionalShutdown"
  | "clearIntentionalShutdown"
>;

/** The session surface the runner-readiness path calls. */
export type ReadinessSessionManager = Pick<
  SessionManager,
  "getSession" | "findSession" | "hasSession" | "getDeviceLabels" | "releaseSession"
>;

/** The daemon-state members the runner-readiness path reads. */
export interface ReadinessDaemonState {
  isInitialized(): boolean;
  getSessionManager(): ReadinessSessionManager;
  getDevicePool(): ReadinessDevicePool;
}

export interface StartDeviceRunnerReadinessInput {
  autolockEnabled?: boolean;
  boot: DeviceBootResult;
  args: StartDeviceArgs;
  operationName: string;
  bootService: DeviceBootService;
  deviceUtils: PlatformDeviceManager;
  daemonState: ReadinessDaemonState;
  totalDeadlineMs: number;
  readinessTimeoutMs: number;
  timer: Timer;
  signal: AbortSignal | undefined;
  progress: ProgressCallback | undefined;
  perf: ReturnType<typeof createPerformanceTracker>;
  requestedIdentity: string;
  ensureCtrlProxyReady: (request: RunnerReadinessRequest) => Promise<void>;
  releaseReadinessReservations: DeviceReadinessReservation[];
  publishRecoveredReadinessMarker?: (device: BootedDevice) => void;
  collectColdBootSettlement: ColdBootSettlementCollector;
}
