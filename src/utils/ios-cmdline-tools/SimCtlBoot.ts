import {
  STATE_READ_RETRY_BACKOFF_MS,
  AppleDevice,
  normalizeIosVersion,
  isDeviceAvailable,
  parseAlreadyBootedCoreSimulator405State,
  SimCtlBootOptions,
  SimulatorBootState,
  SimulatorBootLease,
} from "./SimCtlSupport";

import { errorMessage } from "../describeUnknownError";

import type { HostChildProcess as ChildProcess } from "../HostCommandExecutor";

import { logger } from "../logger";
import { createSimulatorLaunchHandle } from "./simulatorLaunchHandle";

import { ExecResult, ActionableError, BootedDevice } from "../../models";
import { DeviceAlreadyRunningError } from "../../models/DeviceAlreadyRunningError";
import { Timer } from "../SystemTimer";
import { raceWithDeadline } from "../raceWithDeadline";
import type { DiscoveryObservationSequence } from "../DiscoveryObservationSequence";
import { createGlobalPerformanceTracker } from "../PerformanceTracker";
import {
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  SIMULATOR_BOOT_CLEANUP_TIMEOUT_MS,
} from "../deviceTimeouts";

import { inferIosFormFactor } from "./iosDeviceType";

import { getAbortSignal } from "../AbortContext";
import { Mutex } from "async-mutex";

import { type IdGenerator } from "../IdGenerator";

import { type SimulatorAppPresenter } from "./SimulatorAppPresenter";

export interface SimCtlBootContext {
  timer: Timer;
  getBootedSimulatorsChecked(
    timeoutMs?: number,
    signal?: AbortSignal,
    options?: { bypassCache?: boolean },
  ): Promise<BootedDevice[]>;
  bootPresentationGenerations: Map<string, string>;
  idGenerator: IdGenerator;
  shutdownAfterFailedStart(udid: string, lease: SimulatorBootLease): Promise<void>;
  presentSimulatorAfterStart(
    udid: string,
    bootGeneration: string,
    signal?: AbortSignal,
  ): Promise<void>;
  simulatorAppPresenter: SimulatorAppPresenter;
  shutdownSimulatorCoordinated(
    udid: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    expectedOwnerToken?: object,
  ): Promise<void>;
  simulatorBoots: Map<string, SimulatorBootState>;
  bootOptions: SimCtlBootOptions;
  executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
  readSimulatorTarget(
    udid: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AppleDevice | undefined>;
  observationSequence: DiscoveryObservationSequence;
  /** Drop the cached simulator listing; a boot changes the state it recorded. */
  invalidateDeviceListCache(): void;
}
/** Trailing options for `SimCtlBoot.runCoordinatedBoot`. */
interface CoordinatedBootOptions<T> {
  /** The boot work to run while holding the simulator's boot lease. */
  operation: () => Promise<T>;
  /** This call starts the boot itself (rejects when the simulator is already running). */
  ownsBoot: boolean;
  /** Adopts a prior successful boot when the simulator is still booted. */
  adoptPriorSuccess?: () => Promise<T>;
}

export class SimCtlBoot {
  constructor(private readonly context: SimCtlBootContext) {}

  async startSimulator(
    udid: string,
    timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
  ): Promise<ChildProcess> {
    const deadlineMs = this.bootDeadline(timeoutMs);
    const startSignal = getAbortSignal();
    const lease = await this.acquireSimulatorBoot(udid, deadlineMs, startSignal);
    try {
      if (this.context.timer.now() >= deadlineMs) {
        throw new DOMException(`Timed out waiting to start iOS simulator ${udid}`, "TimeoutError");
      }
      if (startSignal?.aborted) {
        throw startSignal.reason ?? new ActionableError(`iOS simulator start aborted for ${udid}`);
      }
      if (lease.state.lastBootSucceeded) {
        const simulatorStillBooted = (
          await this.context.getBootedSimulatorsChecked(
            this.remainingBootTimeoutMs(udid, deadlineMs),
            undefined,
            { bypassCache: true },
          )
        ).some((simulator) => simulator.deviceId === udid);
        if (simulatorStillBooted) {
          throw new DeviceAlreadyRunningError(
            `iOS simulator ${udid} is already running`,
            "ios",
            udid,
          );
        }
        lease.state.lastBootSucceeded = false;
        lease.state.ownerToken = undefined;
      }
      await this.startSimulatorExclusive(udid, deadlineMs, startSignal, lease);
      const ownerToken = {};
      lease.state.lastBootSucceeded = true;
      lease.state.ownerToken = ownerToken;
      return this.createSimulatorHandle(udid, ownerToken);
    } finally {
      lease.release();
    }
  }

  async startSimulatorExclusive(
    udid: string,
    deadlineMs: number,
    startSignal: AbortSignal | undefined,
    lease: SimulatorBootLease,
  ): Promise<void> {
    logger.debug(`Starting iOS simulator ${udid}`);
    const perf = createGlobalPerformanceTracker();

    // `bootstatus -b` is idempotent: it boots shutdown simulators, accepts
    // already-booted simulators, and waits until CoreSimulator reports ready.
    // Its exit code alone is not trustworthy, so the post-condition (device
    // state == Booted) is verified and a wedge is retried. See
    // {@link bootAndVerify}.
    perf.startOperation("bootstatus");
    try {
      this.context.bootPresentationGenerations.delete(udid);
      await this.runOwnedBoot(udid, lease, () => this.bootAndVerify(udid, deadlineMs));
    } finally {
      perf.endOperation("bootstatus");
    }

    await this.waitForPresentationAfterStart(
      udid,
      this.context.idGenerator.next(),
      deadlineMs,
      startSignal,
    );
    if (startSignal?.aborted) {
      await this.failBootWithCleanup(
        udid,
        lease,
        startSignal.reason ?? new ActionableError(`iOS simulator start aborted for ${udid}`),
      );
    }
  }

  async waitForPresentationAfterStart(
    udid: string,
    bootGeneration: string,
    deadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const remainingMs = Math.min(1_000, deadlineMs - this.context.timer.now());
    if (remainingMs <= 0 || signal?.aborted) {
      return;
    }
    const presentation = this.context.presentSimulatorAfterStart(udid, bootGeneration);

    const timeout = new Error("Simulator presentation deadline expired");
    try {
      await raceWithDeadline(presentation, {
        timer: this.context.timer,
        timeoutMs: remainingMs,
        signal,
        label: "Simulator presentation",
        timeoutError: () => timeout,
      });
    } catch (error) {
      if (error !== timeout && !signal?.aborted) {
        throw error;
      }
    }
  }

  async presentSimulatorAfterStart(
    udid: string,
    bootGeneration: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    try {
      if (signal) {
        await this.waitForPresentationAfterStart(
          udid,
          bootGeneration,
          this.context.timer.now() + 1_000,
          signal,
        );
        return;
      }
      const generation = this.context.bootPresentationGenerations.get(udid) ?? bootGeneration;
      this.context.bootPresentationGenerations.set(udid, generation);
      await this.context.simulatorAppPresenter.presentAfterStart(udid, generation);
    } catch (error) {
      // The presenter warns on GUI launch failure; unexpected errors cannot fail a start.
      logger.debug(`Could not present Simulator.app for ${udid}: ${error}`);
    }
  }

  createSimulatorHandle(udid: string, ownerToken: object): ChildProcess {
    // `simctl bootstatus -b` is synchronous, so there is no long-lived OS child
    // process to hand back. Rather than fabricate a mock handle whose `kill()` is
    // a no-op (issue #3938), return an honest handle: `pid` is undefined (no OS
    // process), and `kill()` performs the meaningful cancellation for a simulator
    // — shutting it back down. `ChildProcess.kill` is synchronous, so the
    // boolean result reports initiation; exit is emitted only after shutdown settles.
    return createSimulatorLaunchHandle(() => {
      // Cancellation cleanup must not inherit an already-aborted request signal.
      const cleanupSignal = new AbortController().signal;
      return this.context.shutdownSimulatorCoordinated(
        udid,
        SIMULATOR_BOOT_CLEANUP_TIMEOUT_MS,
        cleanupSignal,
        ownerToken,
      );
    }, udid);
  }

  async runOwnedBoot<T>(
    udid: string,
    lease: SimulatorBootLease,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      return this.failBootWithCleanup(udid, lease, error);
    }
  }

  private async failBootWithCleanup(
    udid: string,
    lease: SimulatorBootLease,
    error: unknown,
  ): Promise<never> {
    try {
      await this.context.shutdownAfterFailedStart(udid, lease);
    } catch (cleanupError) {
      logger.warn(
        `[iOS] Boot cleanup for ${udid} was unconfirmed: ${errorMessage(cleanupError)}`,
        cleanupError,
      );
      // Shared abort reasons belong to every signal consumer; annotate only a copy.
      if (error instanceof Error && error === getAbortSignal()?.reason) {
        error =
          error instanceof DOMException
            ? new DOMException(error.message, error.name)
            : Object.create(Object.getPrototypeOf(error), Object.getOwnPropertyDescriptors(error));
      }
      // Keep owned error identity and subtype so timeout/retry classification survives.
      if (error instanceof Error && Object.isExtensible(error)) {
        const note = `Simulator cleanup was unconfirmed: ${errorMessage(cleanupError)}`;
        Object.defineProperties(error, {
          message: { value: `${error.message} ${note}`, writable: true, configurable: true },
          cleanupError: { value: cleanupError, configurable: true },
          cleanupNote: {
            value: note,
            configurable: true,
          },
        });
      }
      throw error;
    }
    throw error;
  }

  async runCoordinatedBoot<T>(
    udid: string,
    deadlineMs: number,
    signal: AbortSignal | undefined,
    options: CoordinatedBootOptions<T>,
  ): Promise<T> {
    const { operation, ownsBoot, adoptPriorSuccess } = options;
    const lease = await this.acquireSimulatorBoot(udid, deadlineMs, signal);
    const priorBootSucceeded = lease.state.lastBootSucceeded;
    if (!priorBootSucceeded) {
      lease.state.lastBootSucceeded = false;
    }
    try {
      if (this.context.timer.now() >= deadlineMs) {
        throw new DOMException(`Timed out waiting to start iOS simulator ${udid}`, "TimeoutError");
      }
      if (signal?.aborted) {
        throw signal.reason ?? new ActionableError(`iOS simulator start aborted for ${udid}`);
      }
      if (priorBootSucceeded && adoptPriorSuccess) {
        const simulatorStillBooted = (
          await this.context.getBootedSimulatorsChecked(
            this.remainingBootTimeoutMs(udid, deadlineMs),
            undefined,
            { bypassCache: true },
          )
        ).some((simulator) => simulator.deviceId === udid);
        if (simulatorStillBooted) {
          return await adoptPriorSuccess();
        }
        lease.state.lastBootSucceeded = false;
        lease.state.ownerToken = undefined;
      }
      if (lease.state.lastBootSucceeded && ownsBoot) {
        throw new DeviceAlreadyRunningError(
          `iOS simulator ${udid} is already running`,
          "ios",
          udid,
        );
      }
      const result = ownsBoot ? await this.runOwnedBoot(udid, lease, operation) : await operation();
      lease.state.lastBootSucceeded = true;
      return result;
    } finally {
      lease.release();
    }
  }

  async acquireSimulatorBoot(
    udid: string,
    deadlineMs: number | undefined,
    signal: AbortSignal | undefined,
    operation: "start" | "shut down" | "erase" = "start",
  ): Promise<SimulatorBootLease> {
    if (signal?.aborted) {
      throw signal.reason ?? new ActionableError(`iOS simulator ${operation} aborted for ${udid}`);
    }

    let state = this.context.simulatorBoots.get(udid);
    if (!state) {
      state = { mutex: new Mutex(), lastBootSucceeded: false, ownerToken: undefined };
      this.context.simulatorBoots.set(udid, state);
    }

    let abandoned = false;
    let acquiredRelease: (() => void) | undefined;
    const acquirePromise = state.mutex.acquire().then((release) => {
      acquiredRelease = release;
      if (abandoned) {
        acquiredRelease = undefined;
        this.releaseSimulatorBoot(udid, state, release);
      }
      return release;
    });

    let acquired = false;
    try {
      const release = await raceWithDeadline(acquirePromise, {
        timer: this.context.timer,
        timeoutMs:
          deadlineMs === undefined ? undefined : Math.max(0, deadlineMs - this.context.timer.now()),
        signal,
        label: `iOS simulator ${operation}`,
        timeoutError: () =>
          new DOMException(
            `Timed out waiting to ${operation} iOS simulator ${udid}`,
            "TimeoutError",
          ),
      });
      acquired = true;
      acquiredRelease = undefined;
      return {
        state,
        release: () => this.releaseSimulatorBoot(udid, state, release),
      };
    } finally {
      abandoned = !acquired;
      if (acquiredRelease) {
        const release = acquiredRelease;
        acquiredRelease = undefined;
        this.releaseSimulatorBoot(udid, state, release);
      }
    }
  }

  releaseSimulatorBoot(udid: string, state: SimulatorBootState, release: () => void): void {
    release();
    if (
      !state.lastBootSucceeded &&
      !state.mutex.isLocked() &&
      this.context.simulatorBoots.get(udid) === state
    ) {
      this.context.simulatorBoots.delete(udid);
    }
  }

  async waitForSimulatorReady(
    udid: string,
    timeoutMs?: number,
    options?: { assumeBooted?: boolean },
  ): Promise<BootedDevice> {
    const perf = createGlobalPerformanceTracker();
    const deadlineMs = this.bootDeadline(timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS);
    perf.startOperation("bootstatus");
    try {
      // The cold-boot path passes `assumeBooted`: startSimulator already ran
      // `bootstatus -b` (which throws on failure/timeout), so the device is
      // already fully booted. Re-running the wait here would be a redundant second
      // boot wait with its own independent timeout budget (issue #3938 follow-up),
      // so skip straight to metadata resolution.
      if (options?.assumeBooted) {
        return await this.runCoordinatedBoot(udid, deadlineMs, getAbortSignal(), {
          operation: () =>
            this.resolveReadySimulator(udid, this.remainingBootTimeoutMs(udid, deadlineMs)),
          ownsBoot: false,
        });
      }

      // Use `simctl bootstatus -b` which blocks until the simulator is fully
      // booted (data migration complete, system app ready, springboard launched).
      // This is far more reliable than polling `simctl list devices` for state.
      return await this.runCoordinatedBoot(udid, deadlineMs, getAbortSignal(), {
        operation: async () => {
          const verified = await this.bootAndVerify(udid, deadlineMs);
          return this.resolveReadySimulator(
            udid,
            this.remainingBootTimeoutMs(udid, deadlineMs),
            verified,
          );
        },
        ownsBoot: false,
      });
    } catch (error) {
      throw this.classifyBootReadinessError(udid, error);
    } finally {
      perf.endOperation("bootstatus");
    }
  }

  /**
   * Keep existing UDID diagnostics and preserve the cause for provisioning (#13807).
   * Phase settlement can prefer this contextual operation failure over its own
   * timeout; retaining the cause avoids changing that shared settlement policy.
   */
  classifyBootReadinessError(udid: string, error: unknown): ActionableError {
    const message = errorMessage(error);
    // "Invalid device" means the UDID doesn't exist at all
    if (message.includes("Invalid device")) {
      return new ActionableError(`Simulator with UDID ${udid} not found`, { cause: error });
    }
    return new ActionableError(`Simulator with UDID ${udid} failed to become ready: ${message}`, {
      cause: error,
    });
  }

  /**
   * Boot `udid` and prove it actually reached the `Booted` state, retrying a
   * bounded number of times.
   *
   * `simctl bootstatus -b` is not a trustworthy success signal on its own: a
   * wedged boot can exit 0 while the device is still `Shutdown`, and the
   * trailing `Status=4294967295` line is printed by *healthy* boots on
   * macOS 26 / Xcode 26 (issue #4092) so it cannot be used as a sentinel
   * either. Device state is the signal that actually differs, which is what
   * AutoMobile product boot uses this state check, mirroring the multi-signal
   * readiness proof the Android emulator path already performs.
   *
   * On a failed verification the device is shut down, a bounded backoff is
   * awaited through the injected {@link Timer}, and the boot is retried.
   */
  async bootAndVerify(udid: string, deadlineMs: number): Promise<AppleDevice> {
    const { maxAttempts, retryBackoffMs } = this.context.bootOptions;
    let lastFailure = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let bootstatusReportedAlreadyBooted = false;
      try {
        await this.context.executeCommandArgs(
          ["bootstatus", udid, "-b"],
          this.remainingBootTimeoutMs(udid, deadlineMs),
        );
      } catch (error) {
        if (await this.handleBootstatusRejection(error, udid, deadlineMs, retryBackoffMs)) {
          // A mid-transition 405 was waited out; re-issue bootstatus within
          // this same attempt rather than burning a retry (issue #6411).
          attempt--;
          continue;
        }
        bootstatusReportedAlreadyBooted = true;
      }

      // The boot moved the simulator out of the state any cached listing recorded. Without
      // this, a fast boot (~1.5 s) finishes inside the 5 s listing cache window and the next
      // cached reader still sees the new simulator Shutdown (#15295). Creation and shutdown
      // already invalidate; the raw state read below never reads or writes the cache.
      this.context.invalidateDeviceListCache();

      // A failed or absent state read is not evidence of a failed boot — it
      // means discovery itself is unreliable right now. Retry the read (bounded
      // by the deadline) rather than treating "unknown" the same as "not
      // Booted" and tearing a possibly-healthy simulator back down (#6411).
      const target = await this.readSimulatorTargetRetrying(udid, deadlineMs);
      const state = target?.state;
      if (target?.state === "Booted") {
        // A listing taken between the first invalidation and this confirmation may have cached
        // a Booting row; drop it too so the bind that follows reads the Booted state.
        this.context.invalidateDeviceListCache();
        return target;
      }

      lastFailure = bootstatusReportedAlreadyBooted
        ? `bootstatus reported CoreSimulator error 405 but device state is ${state ?? "unknown"}, not Booted`
        : `bootstatus exited 0 but device state is ${state ?? "unknown"}, not Booted`;
      logger.warn(
        `[iOS] Boot verification failed for ${udid} on attempt ${attempt}/${maxAttempts}: ${lastFailure}`,
      );

      if (attempt < maxAttempts) {
        // Best-effort: shutting down an already-shutdown device errors, and that
        // is fine — the next attempt re-boots from whatever state it is in.
        try {
          await this.context.executeCommandArgs(
            ["shutdown", udid],
            this.remainingBootTimeoutMs(udid, deadlineMs),
          );
        } catch (error) {
          logger.debug(`[iOS] shutdown before boot retry failed for ${udid}: ${error}`);
        }
        // Wait for the shutdown to actually take hold before re-issuing
        // bootstatus, instead of a fixed sleep: `simctl shutdown` returns before
        // the device leaves `Shutting Down`, and re-booting into that in-flight
        // transition is what produces the very 405 handled above (#6411).
        await this.waitForSimulatorSettled(udid, deadlineMs, retryBackoffMs);
      }
    }

    throw new ActionableError(
      `Simulator ${udid} did not reach the Booted state after ${maxAttempts} boot attempt(s): ${lastFailure}. ` +
        "The simulator is likely wedged. Try 'xcrun simctl shutdown all' (or erase the device with " +
        `'xcrun simctl erase ${udid}') and start it again.`,
    );
  }

  /**
   * Classify a `bootstatus` rejection for {@link bootAndVerify}. CoreSimulator
   * can transiently reject `bootstatus` with a structured "current state" 405.
   * Parse the state it reported and branch: `Booted` contradicts the failure
   * (the caller should verify state itself); `Booting`/`Shutting Down` means a
   * prior retry's transition (e.g. our own `shutdown`) has not settled yet, so
   * this waits for it before returning; any other reported state — or an error
   * that isn't this structured 405 at all — is not one this loop knows how to
   * recover from and is rethrown (issue #6411).
   *
   * @returns `true` when the caller should re-issue `bootstatus` within the
   *          same attempt (a mid-transition rejection was waited out); `false`
   *          when the caller should proceed to verify state (a contradictory
   *          "already Booted" 405).
   */
  async handleBootstatusRejection(
    error: unknown,
    udid: string,
    deadlineMs: number,
    retryBackoffMs: number,
  ): Promise<boolean> {
    const reportedState = parseAlreadyBootedCoreSimulator405State(error, udid);
    if (reportedState === undefined) {
      throw error;
    }
    if (reportedState === "Booting" || reportedState === "Shutting Down") {
      logger.debug(
        `[iOS] bootstatus rejected ${udid} mid-transition (${reportedState}); ` +
          `polling for settlement before re-issuing bootstatus: ${error}`,
      );
      await this.waitForSimulatorSettled(udid, deadlineMs, retryBackoffMs);
      await this.waitForBootRetry(udid, retryBackoffMs || STATE_READ_RETRY_BACKOFF_MS, deadlineMs);
      return true;
    }
    if (reportedState !== "Booted") {
      throw error;
    }
    logger.debug(
      `[iOS] bootstatus returned expected CoreSimulator error 405 for ${udid}; verifying simulator state: ${error}`,
    );
    return false;
  }

  /**
   * Poll device state (through {@link readSimulatorStateRetrying}, so a
   * transient discovery failure does not abort the wait) until it is no
   * longer mid-transition (`Booting` / `Shutting Down`), or the boot deadline
   * is exhausted. Used both before re-issuing `bootstatus` after a retry
   * shutdown and after a mid-transition CoreSimulator 405 rejection (#6411).
   */
  async waitForSimulatorSettled(
    udid: string,
    deadlineMs: number,
    pollIntervalMs: number,
  ): Promise<void> {
    for (;;) {
      const state = await this.readSimulatorStateRetrying(udid, deadlineMs);
      if (state !== "Booting" && state !== "Shutting Down") {
        return;
      }
      await this.waitForBootRetry(udid, pollIntervalMs || STATE_READ_RETRY_BACKOFF_MS, deadlineMs);
    }
  }

  async waitForBootRetry(udid: string, delayMs: number, deadlineMs: number): Promise<void> {
    const boundedDelayMs = Math.min(delayMs, this.remainingBootTimeoutMs(udid, deadlineMs));
    const signal = getAbortSignal();
    if (!signal) {
      await this.context.timer.sleep(boundedDelayMs);
      return;
    }
    let delayHandle: NodeJS.Timeout | undefined;
    try {
      await raceWithDeadline(
        new Promise<void>((resolve) => {
          delayHandle = this.context.timer.setTimeout(resolve, boundedDelayMs);
        }),
        { timer: this.context.timer, signal, label: "iOS simulator boot retry" },
      );
      signal.throwIfAborted();
    } finally {
      if (delayHandle) {
        this.context.timer.clearTimeout(delayHandle);
      }
    }
  }

  bootDeadline(timeoutMs: number): number {
    return this.context.timer.now() + timeoutMs;
  }

  /**
   * Compute the time left before `deadlineMs`, for sizing the next boot
   * recovery step's own command timeout. Throws `ActionableError` (naming the
   * UDID and the elapsed budget) once the deadline itself has passed, so the
   * same condition — the boot deadline elapsing between recovery steps —
   * surfaces in one classified shape regardless of which of the three boot
   * entry points (`waitForSimulatorReady`, `bootSimulator`, or a caller of
   * either) is waiting on it (issue #6413).
   */
  remainingBootTimeoutMs(udid: string, deadlineMs: number): number {
    getAbortSignal()?.throwIfAborted();
    const remainingMs = deadlineMs - this.context.timer.now();
    if (remainingMs <= 0) {
      throw new ActionableError(
        `Simulator boot verification for ${udid} timed out before the next recovery step ` +
          `(deadline elapsed ${-remainingMs}ms ago)`,
        { cause: new DOMException("Simulator boot deadline expired", "TimeoutError") },
      );
    }
    return remainingMs;
  }

  /**
   * Read the current CoreSimulator state for a device, bypassing the device
   * list cache so boot verification never trusts a stale snapshot.
   * @returns the state string (e.g. "Booted", "Shutdown"), or undefined when
   *          the device is absent from the listing.
   * @throws when discovery itself fails (e.g. `simctl list devices --json`
   *         times out or its output cannot be parsed) — a failed read is not
   *         evidence of a failed boot, so callers must not conflate the two
   *         (issue #6411). {@link readSimulatorStateRetrying} is the retrying
   *         wrapper boot verification should use instead of calling this
   *         directly.
   */
  async readSimulatorState(
    udid: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    // Raw reads never join cached/last-good inventory or enrich displays. Let
    // discovery failures propagate to the retrying caller (#6411, #6576).
    return (await this.context.readSimulatorTarget(udid, timeoutMs, signal))?.state;
  }

  /**
   * {@link readSimulatorState}, retrying a discovery failure (bounded by the
   * boot deadline) instead of surfacing it. A `simctl list devices --json`
   * timeout/parse hiccup is transient and unrelated to whether the simulator
   * actually booted, so boot verification retries the *read* here rather than
   * treating "could not tell" as "not Booted" and tearing the device down
   * (issue #6411).
   */
  async readSimulatorStateRetrying(udid: string, deadlineMs: number): Promise<string | undefined> {
    return (await this.readSimulatorTargetRetrying(udid, deadlineMs))?.state;
  }

  private async readSimulatorTargetRetrying(
    udid: string,
    deadlineMs: number,
  ): Promise<AppleDevice | undefined> {
    for (;;) {
      try {
        return await this.context.readSimulatorTarget(
          udid,
          this.remainingBootTimeoutMs(udid, deadlineMs),
        );
      } catch (error) {
        // Expected to happen occasionally (a transient simctl hiccup); safe to
        // retry within the boot deadline rather than surfacing immediately.
        logger.debug(
          `[iOS] Could not read simulator state for ${udid}; retrying within the boot deadline: ${errorMessage(error)}`,
        );
        await this.waitForBootRetry(udid, STATE_READ_RETRY_BACKOFF_MS, deadlineMs);
      }
    }
  }

  /**
   * Find a device by UDID whose `state` is `Booted`, directly from `simctl
   * list devices --json`. This is the single lookup both boot-completion
   * paths share — {@link resolveRegisteredBootSimulator} and
   * {@link resolveReadySimulator} — so a finished boot's post-condition
   * cannot drift between them again (issue #6412). Availability is reported
   * rather than filtered here: callers apply {@link isDeviceAvailable} so
   * each can produce its own not-found vs. unavailable error.
   */
  async findBootedSimulator(
    udid: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AppleDevice | undefined> {
    const target = await this.context.readSimulatorTarget(udid, timeoutMs, signal);
    return target?.state === "Booted" ? target : undefined;
  }

  /**
   * Build the ActionableError for a booted device rejected on availability,
   * naming the actual `availabilityError` (issue #6412) instead of a generic
   * boot-failure message that hides the cause.
   */
  unavailableBootError(udid: string, device: AppleDevice): ActionableError {
    return new ActionableError(
      `Simulator with UDID ${udid} booted but is unavailable` +
        (device.availabilityError ? `: ${device.availabilityError}` : ""),
    );
  }

  /**
   * Look up full device metadata for an already-booted simulator and return it
   * as a BootedDevice. Shared by the cold-boot (assumeBooted) and already-running
   * branches of {@link waitForSimulatorReady}.
   */
  async resolveReadySimulator(
    udid: string,
    timeoutMs?: number,
    verified?: AppleDevice,
  ): Promise<BootedDevice> {
    const perf = createGlobalPerformanceTracker();
    perf.startOperation("deviceLookup");
    // Reuse only this operation's verified row; separate calls still read fresh.
    const simulator = verified ?? (await this.findBootedSimulator(udid, timeoutMs));
    perf.endOperation("deviceLookup");

    if (!simulator) {
      throw new ActionableError(`Simulator with UDID ${udid} not found after boot`);
    }
    if (!isDeviceAvailable(simulator)) {
      throw this.unavailableBootError(udid, simulator);
    }

    return {
      name: simulator.name,
      platform: "ios",
      deviceId: simulator.udid,
      observedAt: this.context.observationSequence.next(),
    } as BootedDevice;
  }

  /**
   * Boot a simulator by UDID
   * @param udid - Device UDID to boot
   * @returns Promise that resolves when boot is initiated
   */
  async bootSimulator(udid: string): Promise<BootedDevice> {
    logger.debug(`Booting iOS simulator ${udid}`);
    const perf = createGlobalPerformanceTracker();

    // Route through the shared verifier so the SESSION AUTO-START path gets the
    // same post-condition check and bounded retry as startSimulator. This is the
    // default path when an MCP session begins with no booted simulator
    // (DeviceReadiness.findOrStartIosDevice -> bootSimulator), so leaving it
    // on the old behaviour would have meant #4094 missed the very scenario it is
    // about. The old code ran a bare `simctl boot`, which does not wait for the
    // boot to finish, then slept a fixed 1s and asked whether the device had
    // shown up in the booted list -- neither a wait nor a proof of readiness.
    const deadlineMs = this.bootDeadline(DEFAULT_DEVICE_READY_TIMEOUT_MS);
    perf.startOperation("simctlBoot");
    return this.runCoordinatedBoot(udid, deadlineMs, getAbortSignal(), {
      operation: async () => {
        this.context.bootPresentationGenerations.delete(udid);
        const verified = await this.bootAndVerify(udid, deadlineMs);
        perf.endOperation("simctlBoot");
        return this.resolveRegisteredBootSimulator(udid, deadlineMs, perf, verified);
      },
      ownsBoot: true,
      adoptPriorSuccess: () => {
        perf.endOperation("simctlBoot");
        return this.resolveRegisteredBootSimulator(udid, deadlineMs, perf);
      },
    });
  }

  async resolveRegisteredBootSimulator(
    udid: string,
    deadlineMs: number,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
    verified?: AppleDevice,
  ): Promise<BootedDevice> {
    perf.startOperation("bootRegistration");
    // A direct boot hands off its fresh verification; adoption still reads raw.
    const timeoutMs = this.remainingBootTimeoutMs(udid, deadlineMs);
    const device = verified ?? (await this.findBootedSimulator(udid, timeoutMs));
    perf.endOperation("bootRegistration");
    if (!device) {
      throw new ActionableError(`Failed to boot iOS simulator ${udid}`);
    }
    if (!isDeviceAvailable(device)) {
      throw this.unavailableBootError(udid, device);
    }
    const iosVersion = normalizeIosVersion(device.runtime, device.os_version);
    return {
      name: device.name,
      platform: "ios",
      deviceId: device.udid,
      observedAt: this.context.observationSequence.next(),
      iosVersion,
      osVersion: iosVersion,
      formFactor: inferIosFormFactor(device.deviceTypeIdentifier),
      runtimeId: device.runtime,
      runtime: device.runtime,
      deviceType: device.deviceTypeIdentifier,
    } as BootedDevice;
  }
}
