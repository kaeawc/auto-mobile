import type { BootedDevice } from "../models";
import type { AdjustableDeadline } from "../utils/AdjustableDeadline";
import type { PerformanceTracker } from "../utils/PerformanceTracker";
import type { RunnerReadinessError } from "./RunnerReadinessError";

export type RunnerReadinessPhase =
  | "package-compatibility"
  | "runner-setup"
  | "runner-connect"
  | "runner-health";

export interface AndroidCompatibilityResult {
  status:
    | "skipped"
    | "not_installed"
    | "compatible"
    | "upgraded"
    | "installed"
    | "reinstalled"
    | "failed";
  acceptedPreinstalled?: boolean;
  error?: string;
  upgradeError?: string;
  reinstallError?: string;
  cause?: unknown;
}

export interface RunnerReadinessRequest {
  device: BootedDevice;
  requestedIdentity: string;
  /** User-visible operation that requires the runner to become responsive. */
  operationName?: string;
  /** Absolute deadline shared with device boot. */
  totalDeadlineMs: number;
  /**
   * Optional movable form of `totalDeadlineMs` for a caller that owns a synthetic ceiling (the
   * observe start flight). When set it wins over `totalDeadlineMs`, and setup phases that are
   * already running follow it when it moves (#15227). Callers with a real deadline omit it.
   */
  deadline?: AdjustableDeadline;
  /** Maximum time allocated to runner readiness within the total deadline. */
  readinessTimeoutMs: number;
  skipCtrlProxyDownload?: boolean;
  perf?: PerformanceTracker;
  signal?: AbortSignal;
  onRunnerSetup?: () => void;
  /** Synchronous admission check under the readiness lock, before any device work. */
  assertCanSetup?: () => void;
}

export interface ReadinessAttemptContext extends RunnerReadinessRequest {
  deadlineFailure?: RunnerReadinessError;
  /**
   * Absolute deadline for the steady-state connect/health phases, opened when
   * `waitForResponsiveClient` begins (null until then) so a long cold
   * provisioning does not consume the short health budget. Setup/provision
   * phases are bounded by `totalDeadlineMs` directly (#5376).
   */
  healthDeadlineMs: number | null;
  phaseElapsedMs: Partial<Record<RunnerReadinessPhase, number>>;
  lastCtrlProxyRebindMs: number;
  ctrlProxyAccessibilityRebindAttempted: boolean;
  /**
   * Throttle clock for the connected-but-unresponsive recovery step (#7533),
   * kept separate from {@link lastCtrlProxyRebindMs} (which gates the
   * disconnected-branch rebind) so the two recovery paths do not interfere
   * with each other's cooldowns.
   */
  lastConnectedRecoveryMs: number;
  /**
   * At most one full CtrlProxy process restart per readiness request (#7533),
   * mirroring iOS's single `forceRestart` between "connected" and "healthy".
   */
  ctrlProxyProcessRestartAttempted: boolean;
  /**
   * When the last successful accessibility-service rebind completed, so
   * escalation to a full process restart can wait out
   * {@link CTRL_PROXY_POST_REBIND_RESTART_GRACE_MS} for the freshly re-bound
   * service to start answering before force-stopping it again.
   */
  lastSuccessfulRebindMs: number;
  /**
   * Consecutive failed health probes since the last actual rebind. The
   * recovery throttle must not discard failures when each probe itself takes
   * longer than the throttle window.
   */
  failedHealthProbesSinceRecovery: number;
}
