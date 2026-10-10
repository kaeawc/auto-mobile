import { ActionableError } from "../models";
import type { Timer } from "../utils/SystemTimer";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type {
  StableVirtualDeviceIdentity,
  VirtualDeviceLifecycleCoordinator,
  VirtualDeviceLifecycleLease,
} from "./virtualDeviceLifecycleCoordinator";

export type DeviceTeardownPhase = "precondition" | "stop" | "destroy" | "verification";

export class DeviceTeardownDeadlineError extends ActionableError {
  constructor() {
    super("Device teardown deadline exceeded");
  }
}

export type DeviceTeardownResolution<TTarget, TResponse> =
  | { target: TTarget }
  | { response: TResponse };

export interface DeviceTeardownRequest {
  identity: StableVirtualDeviceIdentity;
  deadlineMs: number;
  callerSignal?: AbortSignal;
  /**
   * Ordinary teardown outlives a disconnected caller. Deadline-critical,
   * caller-owned cleanup can instead cancel the accepted workflow too.
   */
  cancellationPolicy?: "continue" | "cancel-on-caller-abort";
  /** An already-held reservation transferred atomically from failed provisioning. */
  lifecycleLease?: VirtualDeviceLifecycleLease;
}

export interface DeviceTeardownWorkflow<TTarget, TStop, TResponse> {
  resolve(
    signal: AbortSignal,
    lease: VirtualDeviceLifecycleLease,
  ): Promise<DeviceTeardownResolution<TTarget, TResponse>>;
  stop(
    target: TTarget,
    signal: AbortSignal,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<TStop>;
  destroy(
    target: TTarget,
    signal: AbortSignal,
    retainLeaseUntil: (settlement: Promise<unknown>) => void,
  ): Promise<void>;
  verify(target: TTarget, stop: TStop, signal: AbortSignal): Promise<TResponse>;
  failure(phase: DeviceTeardownPhase, error: unknown, target?: TTarget): TResponse;
}

/**
 * Ownership of a lease transferred in by a failed provision. Exactly one of the
 * teardown entry point or the accepted operation releases it, and `consumed`
 * says which: `execute` claims it, every other exit releases it.
 */
interface TransferredLeaseOwnership {
  readonly lease: VirtualDeviceLifecycleLease | undefined;
  consumed: boolean;
}

function releaseUnconsumedTransferredLease(transfer: TransferredLeaseOwnership): void {
  if (transfer.consumed) {
    return;
  }
  transfer.consumed = true;
  transfer.lease?.release();
}

export interface DeviceTeardownServiceDependencies {
  lifecycleCoordinator: VirtualDeviceLifecycleCoordinator;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
}

/**
 * Owns accepted teardown state and the stop -> destroy -> verify state machine.
 *
 * Caller cancellation normally only stops that caller waiting. The narrowly
 * typed cancel-on-caller-abort policy instead cancels the accepted workflow,
 * while ordinary teardown remains authoritative until platform mutation
 * settles.
 */
export class DeviceTeardownService {
  constructor(private readonly dependencies: DeviceTeardownServiceDependencies) {}

  async teardown<TTarget, TStop, TResponse>(
    request: DeviceTeardownRequest,
    workflow: DeviceTeardownWorkflow<TTarget, TStop, TResponse>,
  ): Promise<TResponse> {
    const leaseTransfer: TransferredLeaseOwnership = {
      lease: request.lifecycleLease,
      consumed: false,
    };
    let accepted = false;
    try {
      if (request.callerSignal?.aborted) {
        throw (
          request.callerSignal.reason ??
          new ActionableError("Device teardown cancelled before it was accepted")
        );
      }

      const promise = this.executeAcceptedWorkflow(request, workflow, leaseTransfer);
      accepted = true;
      void promise.then(
        () => releaseUnconsumedTransferredLease(leaseTransfer),
        () => releaseUnconsumedTransferredLease(leaseTransfer),
      );
      return await this.waitForCaller(promise, request.callerSignal);
    } finally {
      // A transferred reservation has no other handle: an entry point that
      // never hands it to an accepted workflow must release it, or the
      // stableId stays reserved forever and every later provision/start/
      // teardown burns its own deadline waiting on nobody. Once the workflow
      // owns it, only that workflow may release it — this caller may have
      // stopped waiting while the workflow is still running.
      if (!accepted) {
        releaseUnconsumedTransferredLease(leaseTransfer);
      }
    }
  }

  private async executeAcceptedWorkflow<TTarget, TStop, TResponse>(
    request: DeviceTeardownRequest,
    workflow: DeviceTeardownWorkflow<TTarget, TStop, TResponse>,
    leaseTransfer: TransferredLeaseOwnership,
  ): Promise<TResponse> {
    const controller = new AbortController();
    const timeoutError = new DeviceTeardownDeadlineError();
    const cancelAcceptedOperation = () => {
      controller.abort(
        request.callerSignal?.reason ??
          new ActionableError("Device teardown caller cancelled the accepted operation"),
      );
    };
    if (request.cancellationPolicy === "cancel-on-caller-abort") {
      if (request.callerSignal?.aborted) {
        cancelAcceptedOperation();
      } else {
        request.callerSignal?.addEventListener("abort", cancelAcceptedOperation, { once: true });
      }
    }
    const remainingMs = request.deadlineMs - this.dependencies.timer.now();
    const deadlineTimer =
      remainingMs > 0
        ? this.dependencies.timer.setTimeout(() => controller.abort(timeoutError), remainingMs)
        : undefined;
    if (remainingMs <= 0) {
      controller.abort(timeoutError);
    }
    try {
      return await this.execute(request, controller.signal, workflow, leaseTransfer);
    } finally {
      if (deadlineTimer !== undefined) {
        this.dependencies.timer.clearTimeout(deadlineTimer);
      }
      request.callerSignal?.removeEventListener("abort", cancelAcceptedOperation);
    }
  }

  private async execute<TTarget, TStop, TResponse>(
    request: DeviceTeardownRequest,
    signal: AbortSignal,
    workflow: DeviceTeardownWorkflow<TTarget, TStop, TResponse>,
    leaseTransfer: TransferredLeaseOwnership,
  ): Promise<TResponse> {
    let phase: DeviceTeardownPhase = "precondition";
    let target: TTarget | undefined;
    let lease = leaseTransfer.lease;
    let pendingSettlements = 0;
    let workflowSettled = false;
    const retainLeaseUntil = (settlement: Promise<unknown>): void => {
      pendingSettlements++;
      void settlement.then(
        () => {
          pendingSettlements--;
          if (workflowSettled && pendingSettlements === 0) {
            lease?.release();
          }
        },
        () => {
          pendingSettlements--;
          if (workflowSettled && pendingSettlements === 0) {
            lease?.release();
          }
        },
      );
    };
    const awaitStep = async <T>(operation: Promise<T>): Promise<T> => {
      try {
        return await raceWithDeadline(operation, {
          timer: this.dependencies.timer,
          signal,
          label: "Device teardown",
        });
      } catch (error) {
        // A nested platform command may register its own settlement only after
        // this race ends. Hold the lease through that registration and command.
        if (signal.aborted) {
          retainLeaseUntil(operation);
        }
        throw error;
      }
    };
    try {
      if (lease) {
        // This is the only path that consumes a transferred lease; from here
        // the `finally` below (or `retainLeaseUntil`) owns its release.
        leaseTransfer.consumed = true;
        lease.transitionToTeardown();
      } else {
        lease = await this.dependencies.lifecycleCoordinator.reserve(
          { kind: "stable", ...request.identity },
          {
            operation: "teardown",
            deadlineMs: request.deadlineMs,
            signal,
          },
        );
      }
      signal.throwIfAborted();
      const resolution = await awaitStep(workflow.resolve(signal, lease));
      signal.throwIfAborted();
      if ("response" in resolution) {
        return resolution.response;
      }
      target = resolution.target;
      phase = "stop";
      const stop = await awaitStep(workflow.stop(target, signal, retainLeaseUntil));
      signal.throwIfAborted();
      phase = "destroy";
      await awaitStep(workflow.destroy(target, signal, retainLeaseUntil));
      // A deadline-critical caller may have stopped waiting while platform I/O
      // ignored its abort signal. Never let that late settlement publish a
      // successful verification result for the cancelled accepted operation.
      signal.throwIfAborted();
      phase = "verification";
      const response = await awaitStep(workflow.verify(target, stop, signal));
      signal.throwIfAborted();
      return response;
    } catch (error) {
      return workflow.failure(phase, signal.aborted ? (signal.reason ?? error) : error, target);
    } finally {
      workflowSettled = true;
      if (pendingSettlements === 0) {
        lease?.release();
      }
    }
  }

  private async waitForCaller<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) {
      return await promise;
    }
    if (signal.aborted) {
      throw signal.reason ?? new ActionableError("Device teardown caller cancelled");
    }
    return await raceWithDeadline(promise, {
      timer: this.dependencies.timer,
      signal,
      label: "Device teardown caller",
    });
  }
}
