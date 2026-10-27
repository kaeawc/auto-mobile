import type { IosCtrlProxyRuntime } from "./IosCtrlProxyRuntime";
import { CtrlProxyStartupCancelledByStopError } from "./CtrlProxyStartupCancelledByStopError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { PortManager } from "../../utils/PortManager";
import { type RunnerOwnership } from "./IosCtrlProxyProcessClient";
import { withRemainingBudget } from "../../utils/withRemainingBudget";
import {
  FORCE_STOP_OWNERSHIP_CHECK_TIMEOUT_MS,
  FORCE_STOP_KILL_RESERVE_MS,
} from "./IosCtrlProxyContracts";

interface IosCtrlProxyTeardownHost {
  clearCaches(): void;
  useRemoteRunner(): boolean;
  isSimulator(): boolean;
  stopIproxyTunnel(options?: {
    clearDevicePort?: boolean;
    stopSupervisor?: boolean;
  }): Promise<void>;
}

/** Retires owned runners and tunnels with cancellation and shutdown deadlines. */
export class IosCtrlProxyTeardown {
  constructor(
    private readonly state: Pick<
      IosCtrlProxyRuntime,
      | "isStopping"
      | "processSupervisor"
      | "tunnelClient"
      | "xcTestProcessId"
      | "runnerGenerationTokens"
      | "xcTestProcess"
      | "device"
      | "remoteRunner"
      | "timer"
      | "processClient"
      | "sharedStart"
      | "runnerAbortController"
      | "steps"
    >,
    private readonly host: IosCtrlProxyTeardownHost,
  ) {}

  /** Force-stop the runner within a shutdown deadline. Public so tests can drive shutdown teardown directly. */
  async forceStopForShutdown(deadline: number): Promise<void> {
    this.state.isStopping = true;
    this.state.processSupervisor.stop();
    const stopTunnel = this.state.tunnelClient.prepareForcedStop();

    const runnerPid = this.state.xcTestProcessId;
    const expectedGenerationToken =
      runnerPid !== null ? this.state.runnerGenerationTokens.get(runnerPid) : undefined;
    if (runnerPid !== null) {
      this.state.runnerGenerationTokens.delete(runnerPid);
    }
    this.state.xcTestProcessId = null;
    this.state.xcTestProcess = null;
    this.host.clearCaches();
    PortManager.release(this.state.device.deviceId);

    if (this.host.useRemoteRunner()) {
      await Promise.allSettled([
        runnerPid
          ? this.state.remoteRunner.stop({ deviceId: this.state.device.deviceId, pid: runnerPid })
          : undefined,
        stopTunnel.stopRemote(),
      ]);
      return;
    }

    stopTunnel.killLocal();
    if (runnerPid) {
      const preKillDeadlineMs = deadline - FORCE_STOP_KILL_RESERVE_MS;
      if (preKillDeadlineMs <= this.state.timer.now()) {
        logger.warn(
          `[IOSCtrlProxy] ownership-unverified for tracked runner PID ${runnerPid} before ` +
            "the kill reserve; skipping forced termination",
        );
        return;
      }
      const mayTerminate = await this.isRunnerStillOwnedWithinShutdownDeadline(
        runnerPid,
        preKillDeadlineMs,
      );
      if (mayTerminate) {
        await this.state.processClient
          .terminateProcessTree(runnerPid, deadline, {
            skipGraceful: true,
            expectedDeviceId: this.state.device.deviceId,
            expectedGenerationToken,
            preKillDeadlineMs,
          })
          .catch((error) => {
            logger.warn(`[IOSCtrlProxy] Forced CtrlProxy runner termination failed: ${error}`);
          });
      } else {
        logger.warn(
          `[IOSCtrlProxy] Tracked runner PID ${runnerPid} is confirmed foreign ` +
            `(PID-reused); skipping forced termination`,
        );
      }
    }
  }

  /**
   * Re-verifies ownership of `runnerPid` right before `forceStopForShutdown`'s tree
   * kill, mirroring the re-checks in `stop()` and the hung-runner path (#6579). The
   * field is already nulled by this point, so the pid is passed explicitly. Bounded
   * by a short timeout, separate from the caller's terminateProcessTree budget, so a
   * slow `ps`/`kill -0` round trip cannot itself consume the 250 ms force-stop
   * deadline — on timeout we fail OPEN (treat as still owned) to preserve today's
   * shutdown behavior rather than silently skip a genuinely hung runner. An absent
   * root also proceeds because its original process group may still have live members.
   */
  async isRunnerStillOwnedWithinShutdownDeadline(
    runnerPid: number,
    deadlineMs: number,
  ): Promise<boolean> {
    try {
      return await withRemainingBudget(
        deadlineMs,
        this.state.timer,
        undefined,
        async (_signal, remainingMs) => {
          const probeBudgetMs = Math.min(FORCE_STOP_OWNERSHIP_CHECK_TIMEOUT_MS, remainingMs);
          const timedOut = new Error("Runner ownership probe timed out");
          let ownership: RunnerOwnership;
          try {
            ownership = await raceWithDeadline(
              this.state.processClient.checkRunnerOwnership(
                runnerPid,
                this.state.device.deviceId,
                this.state.timer.now() + probeBudgetMs,
              ),
              {
                timer: this.state.timer,
                timeoutMs: probeBudgetMs,
                label: "Runner ownership probe",
                timeoutError: () => timedOut,
              },
            );
          } catch (error) {
            if (error !== timedOut) {
              throw error;
            }
            ownership = "owned";
          }
          return ownership !== "foreign";
        },
      );
    } catch (error) {
      // A failed ownership check (exec error) is treated the same as "cannot
      // disprove ownership": fail open so a genuinely hung runner still gets
      // torn down during shutdown, matching the timeout fallback above.
      logger.debug(
        `[IOSCtrlProxy] Ownership re-verification for runner ${runnerPid} failed; ` +
          `assuming owned: ${errorMessage(error)}`,
      );
      return true;
    }
  }

  async terminateHungRunnerProcess(hungPid: number): Promise<void> {
    if (this.host.useRemoteRunner()) {
      // The runner PID belongs to the macOS HOST, not this (Docker) container —
      // a local kill would miss it (or signal an unrelated same-PID container
      // process). Stop it through remote runner, matching stop() (#2834 review).
      try {
        await this.state.remoteRunner.stop({ deviceId: this.state.device.deviceId, pid: hungPid });
      } catch (error) {
        logger.warn(
          `[IOSCtrlProxy] Remote runner stop of hung runner ${hungPid} failed: ` +
            `${errorMessage(error)}`,
        );
      }
    } else {
      // Tree kill, not single-PID: the tracked PID is the shell wrapper, and
      // signaling only it would orphan the xcodebuild child, which keeps the
      // hung in-sim runner alive to be re-adopted or contend the port on the
      // next start (#2834 review).
      await this.state.processClient.terminateProcessTree(hungPid, undefined, {
        expectedGenerationToken: this.state.runnerGenerationTokens.get(hungPid),
      });
    }
  }

  /**
   * Stop CtrlProxy
   */
  async stop(deadline?: number): Promise<void> {
    this.beginStop();
    // A remote start can return its PID after shutdown has begun. Drain the
    // shared start first so it observes cancellation and retires that runner
    // before this stop snapshots the tracked PID.
    await this.cancelAndAwaitSharedStart();
    await this.stopTrackedService(deadline);
  }

  beginStop(): void {
    logger.info("[IOSCtrlProxy] Stopping CtrlProxy");
    this.state.isStopping = true;
    this.state.processSupervisor.stop();
  }

  private async cancelAndAwaitSharedStart(): Promise<void> {
    const sharedStart = this.state.sharedStart;
    if (!sharedStart || sharedStart.completed) {
      return;
    }
    if (!sharedStart.teardownCommitted && !sharedStart.controller.signal.aborted) {
      sharedStart.controller.abort(new CtrlProxyStartupCancelledByStopError());
    }
    try {
      await sharedStart.completion;
    } catch (error) {
      // A startup rejection is expected after stop cancels it; teardown below owns the runner.
      logger.debug(`[IOSCtrlProxy] In-flight startup settled during stop: ${errorMessage(error)}`);
    }
  }

  async stopTrackedService(deadline?: number): Promise<void> {
    // startInternal() may have reset this flag or restarted supervision before its
    // completion settled. Reassert teardown state after the shared-start barrier.
    this.state.isStopping = true;
    this.state.processSupervisor.stop();

    const retiringController = this.state.runnerAbortController;

    if (this.host.useRemoteRunner()) {
      try {
        if (this.state.xcTestProcessId) {
          await this.state.remoteRunner.stop({
            deviceId: this.state.device.deviceId,
            pid: this.state.xcTestProcessId,
          });
        }
      } catch (error) {
        logger.warn(`[IOSCtrlProxy] Remote runner stop failed: ${errorMessage(error)}`);
      }

      if (!this.host.isSimulator()) {
        await this.host.stopIproxyTunnel({ clearDevicePort: true });
      }

      if (this.state.xcTestProcessId !== null) {
        this.state.runnerGenerationTokens.delete(this.state.xcTestProcessId);
      }
      this.state.xcTestProcessId = null;
      this.state.xcTestProcess = null;
      this.host.clearCaches();
      PortManager.release(this.state.device.deviceId);
      this.state.isStopping = false;
      logger.info("[IOSCtrlProxy] Service stopped");
      return;
    }

    // A tunnel-stop failure must not skip runner termination, and it must not leave
    // the retiring runner's abort signal behind once the runner is gone. The port
    // reservation is retained when the runner is confirmed still alive or when the
    // iproxy tunnel stop failed, so the port is not handed to another device while
    // either may still hold it.
    let tunnelStopError: unknown;
    try {
      // Stop iproxy tunnel if running
      await this.host.stopIproxyTunnel({ clearDevicePort: true });
    } catch (error) {
      tunnelStopError = error;
      logger.warn(`[IOSCtrlProxy] iproxy tunnel stop failed: ${errorMessage(error)}`, error);
    }

    const runnerTerminationError = await this.state.steps.terminateTrackedRunner(
      retiringController,
      deadline,
    );

    this.host.clearCaches();
    this.state.isStopping = false;
    if (runnerTerminationError !== undefined) {
      throw new ActionableError(
        `Failed to stop iOS CtrlProxy runner ${this.state.xcTestProcessId}: ` +
          `${errorMessage(runnerTerminationError)}`,
      );
    }
    try {
      // Terminate descendants before abort can synchronously clear process tracking.
      retiringController?.abort(new Error("iOS CtrlProxy runner stopped"));
      if (this.state.runnerAbortController === retiringController) {
        this.state.runnerAbortController = null;
      }
    } finally {
      // iproxy may still hold the port when its stop threw; keep the reservation
      // so another device is not handed a port the live tunnel occupies (#11186).
      if (tunnelStopError === undefined) {
        PortManager.release(this.state.device.deviceId);
      }
    }
    if (tunnelStopError !== undefined) {
      throw toActionableError(tunnelStopError, "Failed to stop iOS CtrlProxy iproxy tunnel");
    }
    logger.info("[IOSCtrlProxy] Service stopped");
  }

  /**
   * Terminate the local runner tracked at the time {@link stop} began, using a
   * single runner identity captured in `retiringController`. Returns the
   * termination error (or `undefined` on success) so the caller decides whether
   * to surface it. The tracking fields are cleared only when they still point at
   * the same runner we set out to retire — an overlapping forceRestart() may have
   * swapped in a newer runner in the meantime, which we must not clobber.
   */
  async terminateTrackedRunner(
    retiringController: AbortController | null,
    deadline?: number,
  ): Promise<unknown> {
    const retiringPid =
      this.state.runnerAbortController === retiringController ? this.state.xcTestProcessId : null;
    const retiringChild = this.state.xcTestProcess;
    if (!retiringPid) {
      return undefined;
    }
    let runnerTerminationError: unknown;
    try {
      if (await this.state.steps.isOwnRunnerProcessAlive(retiringPid)) {
        await this.state.processClient.terminateProcessTree(retiringPid, deadline, {
          expectedGenerationToken: this.state.runnerGenerationTokens.get(retiringPid),
        });
      } else {
        logger.debug(
          `[IOSCtrlProxy] Tracked runner PID ${retiringPid} is not an owned CtrlProxy runner; ` +
            `clearing without terminating`,
        );
      }
    } catch (error) {
      runnerTerminationError = error;
      logger.warn(
        `[IOSCtrlProxy] Failed to terminate tracked CtrlProxy runner ${retiringPid}: ` +
          `${errorMessage(error)}`,
      );
    }
    if (
      runnerTerminationError === undefined &&
      this.state.xcTestProcessId === retiringPid &&
      this.state.xcTestProcess === retiringChild &&
      this.state.runnerAbortController === retiringController
    ) {
      this.state.runnerGenerationTokens.delete(retiringPid);
      this.state.xcTestProcessId = null;
      this.state.xcTestProcess = null;
    }
    return runnerTerminationError;
  }

  /**
   * A physical-device start must never overwrite the handles to a runner that may
   * still be alive: the first `xcodebuild` is `detached`, so once the tracked child
   * and abort controller are replaced nothing, not `stop()` and not shutdown, can
   * terminate it (#10234). Terminate and await any live tracked runner first, and
   * abort its controller. When termination fails the tracking is restored and the
   * start fails, so no second runner is spawned and `stop()` can retry.
   */
  async retireTrackedDeviceRunnerBeforeSpawn(): Promise<void> {
    const retiringPid = this.state.xcTestProcessId;
    const retiringChild = this.state.xcTestProcess;
    const retiringController = this.state.runnerAbortController;
    if (retiringPid !== null && (await this.state.steps.isOwnRunnerProcessAlive(retiringPid))) {
      logger.warn(
        `[IOSCtrlProxy] Tracked CtrlProxy runner PID ${retiringPid} is still alive; ` +
          `terminating it before launching a replacement`,
      );
      // Untrack first so the child's exit event is ignored as stale instead of
      // aborting this very startup or scheduling an auto-restart.
      this.state.xcTestProcessId = null;
      this.state.xcTestProcess = null;
      try {
        await this.state.processClient.terminateProcessTree(retiringPid, undefined, {
          expectedGenerationToken: this.state.runnerGenerationTokens.get(retiringPid),
        });
      } catch (error) {
        this.state.xcTestProcessId = retiringPid;
        this.state.xcTestProcess = retiringChild;
        logger.warn(
          `[IOSCtrlProxy] Failed to terminate runner before replacement: ${errorMessage(error)}`,
          error,
        );
        throw toActionableError(
          error,
          `Failed to terminate CtrlProxy runner PID ${retiringPid} before starting a replacement`,
        );
      }
      this.state.runnerGenerationTokens.delete(retiringPid);
    } else if (retiringPid !== null && this.state.xcTestProcessId === retiringPid) {
      this.state.runnerGenerationTokens.delete(retiringPid);
      this.state.xcTestProcessId = null;
      this.state.xcTestProcess = null;
    }
    if (retiringController) {
      retiringController.abort(new Error("iOS CtrlProxy runner replaced"));
      if (this.state.runnerAbortController === retiringController) {
        this.state.runnerAbortController = null;
      }
    }
  }
}
