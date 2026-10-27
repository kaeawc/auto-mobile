import type { HostChildProcess } from "../../utils/HostCommandExecutor";
import type { PerformanceTracker } from "../../utils/PerformanceTracker";

/**
 * How a launch step obtained the device's runner: `spawned` when it started one,
 * `adopted` when host control already had one running for the device (#14509).
 */
export type RunnerLaunchProvenance = "spawned" | "adopted";

/**
 * How a startup obtained its runner. Adds `deferred` for an own runner that was
 * still starting and was waited for instead of respawned. Only a `spawned` runner
 * is a cold launch owned by this start, so only it is owed the first-launch window.
 */
export type RunnerStartupProvenance = RunnerLaunchProvenance | "deferred";

/** The startup a concurrent `start()` caller can join, and the stop path can cancel. */
export interface SharedCtrlProxyStart {
  controller: AbortController;
  completion: Promise<void>;
  healthPollDeadlineMs: number | null;
  defaultHealthPollDeadlineMs: number | null;
  callerHealthPollDeadlinesMs: Map<symbol, number>;
  teardownCommitted: boolean;
  waitingCallers: number;
  externalWaitingCallers: number;
  completed: boolean;
}

/**
 * The manager's replaceable runner-lifecycle steps. Production wires each to the
 * manager's own implementation; a test injects a fake for only the steps whose
 * real behavior (spawning xcodebuild, polling health, probing process ownership)
 * is not under test, instead of overwriting a private method on the instance.
 */
export interface IosCtrlProxyLifecycleSteps {
  /** The body of one shared startup (`start()` runs it once per joined caller group). */
  startInternal(sharedStart: SharedCtrlProxyStart): Promise<void>;
  /** Waits for an aborted or torn-down startup to settle before a new one may begin. */
  waitForNonJoinableStart(signal: AbortSignal | undefined): Promise<SharedCtrlProxyStart | null>;
  /** Retires the runner a startup published once its last waiting caller cancelled. */
  retireRunnerAfterFinalSharedStartCancellation(sharedStart: SharedCtrlProxyStart): Promise<void>;
  /** Launches the runner on a simulator (xcodebuild test-without-building, or the host runner). */
  startOnSimulator(): Promise<RunnerLaunchProvenance>;
  /** Launches the runner on a physical device (iproxy tunnel plus xcodebuild). */
  startOnDevice(): Promise<RunnerLaunchProvenance>;
  /** Polls the runner's health endpoint; resolves true once it answers. */
  waitForHealthEndpoint(
    sharedStart: SharedCtrlProxyStart,
    perf: PerformanceTracker,
    delayMs: number,
    launchDeadlineMs?: number,
  ): Promise<boolean>;
  /** Completes supervision setup once the health endpoint answers. */
  completeHealthStartup(sharedStart: SharedCtrlProxyStart, perf: PerformanceTracker): Promise<void>;
  /** True when the tracked (or given) runner PID is alive and genuinely our runner. */
  isOwnRunnerProcessAlive(pid?: number | null): Promise<boolean>;
  /** Kills the runner a startup judged hung. */
  terminateHungRunnerProcess(pid: number): Promise<void>;
  /** Terminates the runner `stop()` set out to retire; resolves the failure, if any. */
  terminateTrackedRunner(
    retiringController: AbortController | null,
    deadline?: number,
  ): Promise<unknown>;
  /** One-time removal of the pre-rename CtrlProxy app during `setup()`. */
  uninstallLegacyAppIfPresent(): Promise<void>;
  /** Waits for a host-control start that returned after shutdown began to be retired. */
  fenceLateRemoteStartAfterShutdown(runnerPid: number): Promise<void>;
}

/** Step replacements: given directly, or derived from the manager's own steps to decorate them. */
export type IosCtrlProxyStepOverrides =
  | Partial<IosCtrlProxyLifecycleSteps>
  | ((defaults: IosCtrlProxyLifecycleSteps) => Partial<IosCtrlProxyLifecycleSteps>);

/** A read-only view of the runner bookkeeping, for leak and ownership assertions. */
export interface IosCtrlProxyRunnerSnapshot {
  readonly xcTestProcessId: number | null;
  readonly xcTestProcess: HostChildProcess | null;
  readonly hasRunnerAbortController: boolean;
  readonly isStopping: boolean;
  readonly servicePort: number;
  /** Callers outside the manager still waiting on the in-flight startup; null when none. */
  readonly sharedStartExternalWaitingCallers: number | null;
}
