import { ActionableError, toActionableError } from "../models";
import type { DeviceTeardownOperationStore } from "../db/deviceTeardownOperationRepository";
import { defaultIdGenerator, type IdGenerator } from "./IdGenerator";
import type { Timer } from "./SystemTimer";
import type {
  StableVirtualDeviceIdentity,
  VirtualDeviceLifecycleCoordinator,
  VirtualDeviceLifecycleLease,
} from "./virtualDeviceLifecycleCoordinator";

export type DeviceTeardownPhase = "precondition" | "stop" | "destroy" | "verification";

export type DeviceTeardownResolution<TTarget, TResponse> =
  | { target: TTarget }
  | { response: TResponse };

export interface DeviceTeardownRequest {
  operationId: string;
  fingerprint: string;
  identity: StableVirtualDeviceIdentity;
  deadlineMs: number;
  callerSignal?: AbortSignal;
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
    markDestructionStarted: () => void,
  ): Promise<void>;
  verify(target: TTarget, stop: TStop, signal: AbortSignal): Promise<TResponse>;
  conflict(): TResponse;
  failure(phase: DeviceTeardownPhase, error: unknown, target?: TTarget): TResponse;
  isFailure(response: TResponse): boolean;
}

interface AcceptedTeardown<TResponse> {
  fingerprint: string;
  promise: Promise<TResponse>;
  execution: { destructionStarted: boolean };
  expiryTimer?: NodeJS.Timeout;
  renewalTimer?: NodeJS.Timeout;
  renewalWatchdogs: Set<NodeJS.Timeout>;
  renewalEpoch: number;
  renewalFailures: number;
  runningExpiresAtMs?: number;
  ownerToken: string;
}

export interface DeviceTeardownServiceDependencies {
  lifecycleCoordinator: VirtualDeviceLifecycleCoordinator;
  operationStore?: DeviceTeardownOperationStore;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  resultTtlMs: number;
  idGenerator?: IdGenerator;
}

/**
 * Owns accepted teardown state and the stop -> destroy -> verify state machine.
 *
 * Caller cancellation only stops that caller waiting. The accepted operation
 * receives its own signal and remains authoritative until platform mutation
 * settles, including commands that outlive the request deadline.
 */
export class DeviceTeardownService {
  private readonly operations = new Map<string, AcceptedTeardown<unknown>>();

  constructor(private readonly dependencies: DeviceTeardownServiceDependencies) {}

  async teardown<TTarget, TStop, TResponse>(
    request: DeviceTeardownRequest,
    workflow: DeviceTeardownWorkflow<TTarget, TStop, TResponse>,
  ): Promise<TResponse> {
    const existing = this.operations.get(request.operationId) as
      | AcceptedTeardown<TResponse>
      | undefined;
    if (existing) {
      if (existing.fingerprint !== request.fingerprint) {
        return workflow.conflict();
      }
      return await this.waitForCaller(existing.promise, request.callerSignal);
    }
    if (request.callerSignal?.aborted) {
      throw (
        request.callerSignal.reason ??
        new ActionableError("Device teardown cancelled before it was accepted")
      );
    }

    const execution = { destructionStarted: false };
    const ownerToken = this.dependencies.operationStore
      ? (this.dependencies.idGenerator?.next() ?? defaultIdGenerator.next())
      : "";
    const promise = this.beginAndExecute(request, workflow, execution, ownerToken);
    const entry: AcceptedTeardown<TResponse> = {
      fingerprint: request.fingerprint,
      promise,
      execution,
      renewalWatchdogs: new Set(),
      renewalEpoch: 0,
      renewalFailures: 0,
      ownerToken,
    };
    this.operations.set(request.operationId, entry as AcceptedTeardown<unknown>);
    void promise.then(
      (response) => this.recordTerminalResult(request.operationId, entry, response, workflow),
      () => this.deleteOperation(request.operationId, entry),
    );
    return await this.waitForCaller(promise, request.callerSignal);
  }

  dispose(): void {
    for (const operation of this.operations.values()) {
      if (operation.expiryTimer) {
        this.dependencies.timer.clearTimeout(operation.expiryTimer);
      }
      if (operation.renewalTimer) {
        this.dependencies.timer.clearTimeout(operation.renewalTimer);
      }
      for (const watchdog of operation.renewalWatchdogs) {
        this.dependencies.timer.clearTimeout(watchdog);
      }
    }
    this.operations.clear();
  }

  private async beginAndExecute<TTarget, TStop, TResponse>(
    request: DeviceTeardownRequest,
    workflow: DeviceTeardownWorkflow<TTarget, TStop, TResponse>,
    execution: { destructionStarted: boolean },
    ownerToken: string,
  ): Promise<TResponse> {
    const operationStore = this.dependencies.operationStore;
    if (operationStore) {
      let accepted;
      const nowMs = this.dependencies.timer.now();
      try {
        accepted = await operationStore.begin(
          request.operationId,
          request.fingerprint,
          ownerToken,
          nowMs,
          nowMs + this.dependencies.resultTtlMs,
        );
      } catch (error) {
        return workflow.failure(
          "precondition",
          toActionableError(error, "Failed to persist the teardown operation"),
        );
      }
      if (accepted.status === "conflict") {
        return workflow.conflict();
      }
      if (accepted.status === "completed") {
        return accepted.result as TResponse;
      }
      if (accepted.status === "in_progress") {
        return workflow.failure(
          "precondition",
          new ActionableError(
            "This teardown operation was accepted by an earlier daemon process but has no " +
              "terminal result. Inspect the target state before retrying with a new operation ID.",
          ),
        );
      }
      this.startRenewal(request, ownerToken, operationStore, nowMs + this.dependencies.resultTtlMs);
    }

    const controller = new AbortController();
    const response = await this.execute(request, controller.signal, workflow, execution);
    if (!operationStore) {
      return response;
    }
    if (workflow.isFailure(response) && !execution.destructionStarted) {
      try {
        await operationStore.delete(request.operationId, request.fingerprint, ownerToken);
      } catch (error) {
        return workflow.failure(
          "precondition",
          toActionableError(error, "Failed to clear the rejected teardown operation"),
        );
      }
      return response;
    }
    try {
      const completed = await operationStore.complete(
        request.operationId,
        request.fingerprint,
        ownerToken,
        response,
        this.dependencies.timer.now() + this.dependencies.resultTtlMs,
      );
      if (!completed) {
        throw new ActionableError("Teardown operation ownership was lost before completion");
      }
      return response;
    } catch (error) {
      return workflow.failure(
        "verification",
        toActionableError(error, "Teardown completed but its durable result could not be saved"),
      );
    }
  }

  private async execute<TTarget, TStop, TResponse>(
    request: DeviceTeardownRequest,
    signal: AbortSignal,
    workflow: DeviceTeardownWorkflow<TTarget, TStop, TResponse>,
    execution: { destructionStarted: boolean },
  ): Promise<TResponse> {
    let phase: DeviceTeardownPhase = "precondition";
    let target: TTarget | undefined;
    let lease: VirtualDeviceLifecycleLease | undefined;
    let retainLease = false;
    try {
      lease = await this.dependencies.lifecycleCoordinator.reserve(
        { kind: "stable", ...request.identity },
        {
          operation: "teardown",
          deadlineMs: request.deadlineMs,
          signal,
        },
      );
      const resolution = await workflow.resolve(signal, lease);
      if ("response" in resolution) {
        return resolution.response;
      }
      target = resolution.target;
      const retainLeaseUntil = (settlement: Promise<unknown>): void => {
        retainLease = true;
        void settlement.then(
          () => lease?.release(),
          () => lease?.release(),
        );
      };
      phase = "stop";
      const stop = await workflow.stop(target, signal, retainLeaseUntil);
      phase = "destroy";
      await workflow.destroy(target, signal, retainLeaseUntil, () => {
        execution.destructionStarted = true;
      });
      phase = "verification";
      return await workflow.verify(target, stop, signal);
    } catch (error) {
      return workflow.failure(phase, error, target);
    } finally {
      if (!retainLease) {
        lease?.release();
      }
    }
  }

  private recordTerminalResult<TTarget, TStop, TResponse>(
    operationId: string,
    entry: AcceptedTeardown<TResponse>,
    response: TResponse,
    workflow: DeviceTeardownWorkflow<TTarget, TStop, TResponse>,
  ): void {
    if (this.operations.get(operationId) !== entry) {
      return;
    }
    this.clearRenewalTimers(entry);
    if (workflow.isFailure(response) && !entry.execution.destructionStarted) {
      this.operations.delete(operationId);
      return;
    }
    entry.expiryTimer = this.dependencies.timer.setTimeout(() => {
      this.deleteOperation(operationId, entry);
    }, this.dependencies.resultTtlMs);
  }

  private deleteOperation<TResponse>(
    operationId: string,
    entry: AcceptedTeardown<TResponse>,
  ): void {
    if (this.operations.get(operationId) === entry) {
      this.clearRenewalTimers(entry);
      this.operations.delete(operationId);
    }
  }

  private startRenewal(
    request: DeviceTeardownRequest,
    ownerToken: string,
    operationStore: DeviceTeardownOperationStore,
    expiresAtMs: number,
  ): void {
    const entry = this.getRenewingEntry(request.operationId, ownerToken);
    if (!entry) {
      return;
    }
    entry.runningExpiresAtMs = expiresAtMs;
    entry.renewalFailures = 0;
    this.scheduleRenewal(request, ownerToken, operationStore, this.renewalIntervalMs());
  }

  private scheduleRenewal(
    request: DeviceTeardownRequest,
    ownerToken: string,
    operationStore: DeviceTeardownOperationStore,
    delayMs: number,
  ): void {
    const entry = this.getRenewingEntry(request.operationId, ownerToken);
    if (!entry || entry.runningExpiresAtMs === undefined) {
      return;
    }
    if (entry.renewalTimer) {
      this.dependencies.timer.clearTimeout(entry.renewalTimer);
    }
    const renewalEpoch = ++entry.renewalEpoch;
    entry.renewalTimer = this.dependencies.timer.setTimeout(() => {
      if (this.getRenewingEntry(request.operationId, ownerToken)?.renewalEpoch !== renewalEpoch) {
        return;
      }
      entry.renewalTimer = undefined;
      this.renewRunningOperation(request, ownerToken, operationStore, renewalEpoch);
    }, delayMs);
  }

  private renewRunningOperation(
    request: DeviceTeardownRequest,
    ownerToken: string,
    operationStore: DeviceTeardownOperationStore,
    renewalEpoch: number,
  ): void {
    const entry = this.getRenewingEntry(request.operationId, ownerToken);
    const nowMs = this.dependencies.timer.now();
    if (
      !entry ||
      entry.renewalEpoch !== renewalEpoch ||
      entry.runningExpiresAtMs === undefined ||
      nowMs >= entry.runningExpiresAtMs
    ) {
      return;
    }
    const expiresAtMs = nowMs + this.dependencies.resultTtlMs;
    let settled = false;
    const watchdog = this.dependencies.timer.setTimeout(
      () => {
        if (!settled) {
          entry.renewalWatchdogs.delete(watchdog);
          this.retryRenewal(request, ownerToken, operationStore, renewalEpoch);
        }
      },
      this.renewalRetryDelayMs(entry, nowMs),
    );
    entry.renewalWatchdogs.add(watchdog);

    void operationStore
      .renew(request.operationId, request.fingerprint, ownerToken, expiresAtMs)
      .then(
        (renewed) => {
          settled = true;
          this.dependencies.timer.clearTimeout(watchdog);
          entry.renewalWatchdogs.delete(watchdog);
          if (!renewed) {
            this.retryRenewal(request, ownerToken, operationStore, renewalEpoch);
            return;
          }
          if (
            this.getRenewingEntry(request.operationId, ownerToken)?.renewalEpoch !== renewalEpoch
          ) {
            return;
          }
          entry.runningExpiresAtMs = expiresAtMs;
          entry.renewalFailures = 0;
          this.scheduleRenewal(request, ownerToken, operationStore, this.renewalIntervalMs());
        },
        () => {
          settled = true;
          this.dependencies.timer.clearTimeout(watchdog);
          entry.renewalWatchdogs.delete(watchdog);
          this.retryRenewal(request, ownerToken, operationStore, renewalEpoch);
        },
      );
  }

  private retryRenewal(
    request: DeviceTeardownRequest,
    ownerToken: string,
    operationStore: DeviceTeardownOperationStore,
    renewalEpoch: number,
  ): void {
    const entry = this.getRenewingEntry(request.operationId, ownerToken);
    if (
      !entry ||
      entry.renewalEpoch !== renewalEpoch ||
      entry.runningExpiresAtMs === undefined ||
      this.dependencies.timer.now() >= entry.runningExpiresAtMs - 1
    ) {
      return;
    }
    entry.renewalFailures++;
    this.scheduleRenewal(
      request,
      ownerToken,
      operationStore,
      this.renewalRetryDelayMs(entry, this.dependencies.timer.now()),
    );
  }

  private getRenewingEntry(
    operationId: string,
    ownerToken: string,
  ): AcceptedTeardown<unknown> | undefined {
    const entry = this.operations.get(operationId);
    return entry?.ownerToken === ownerToken ? entry : undefined;
  }

  private renewalIntervalMs(): number {
    return Math.max(1, Math.floor(this.dependencies.resultTtlMs / 2));
  }

  private renewalRetryDelayMs(entry: AcceptedTeardown<unknown>, nowMs: number): number {
    const remainingMs = (entry.runningExpiresAtMs ?? nowMs) - nowMs;
    const baseDelayMs = Math.max(1, Math.floor(this.dependencies.resultTtlMs / 16));
    const maxDelayMs = Math.max(baseDelayMs, Math.floor(this.dependencies.resultTtlMs / 8));
    const backoffMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(entry.renewalFailures, 3));
    return Math.max(1, Math.min(backoffMs, remainingMs - 1));
  }

  private clearRenewalTimers(entry: AcceptedTeardown<unknown>): void {
    entry.renewalEpoch++;
    if (entry.renewalTimer) {
      this.dependencies.timer.clearTimeout(entry.renewalTimer);
      entry.renewalTimer = undefined;
    }
    for (const watchdog of entry.renewalWatchdogs) {
      this.dependencies.timer.clearTimeout(watchdog);
    }
    entry.renewalWatchdogs.clear();
  }

  private async waitForCaller<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) {
      return await promise;
    }
    if (signal.aborted) {
      throw signal.reason ?? new ActionableError("Device teardown caller cancelled");
    }
    let removeAbortListener: (() => void) | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          const abort = () =>
            reject(signal.reason ?? new ActionableError("Device teardown caller cancelled"));
          signal.addEventListener("abort", abort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", abort);
        }),
      ]);
    } finally {
      removeAbortListener?.();
    }
  }
}
