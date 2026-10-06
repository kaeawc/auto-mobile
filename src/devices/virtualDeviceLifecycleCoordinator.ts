import { ActionableError, type Platform } from "../models";
import { toActionableError } from "../models/ActionableError";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

export type VirtualDeviceLifecycleOperation =
  | "start"
  | "provision"
  | "configure"
  | "recovery"
  | "shutdown"
  | "teardown";

export interface StableVirtualDeviceIdentity {
  platform: Platform;
  stableId: string;
}

export interface VirtualDeviceSelectorIdentity {
  platform: Platform;
  selector: string;
}

export type VirtualDeviceLifecycleIdentity =
  | ({ kind: "stable" } & StableVirtualDeviceIdentity)
  | ({ kind: "selector" } & VirtualDeviceSelectorIdentity);

export interface VirtualDeviceLifecycleReservationOptions {
  operation: VirtualDeviceLifecycleOperation;
  deadlineMs: number;
  signal?: AbortSignal;
}

export interface VirtualDeviceLifecycleLease {
  readonly signal: AbortSignal;
  readonly identity: VirtualDeviceLifecycleIdentity;
  bindCanonicalIdentity(
    identity: StableVirtualDeviceIdentity,
    revalidate?: () => Promise<StableVirtualDeviceIdentity>,
  ): Promise<void>;
  transitionToTeardown(): void;
  /**
   * Records that the process this lease's owner started could not be terminated
   * and still holds the device. Later start/provision/configure requests for the
   * device are refused at once, naming the pid, instead of queueing behind a
   * release that may take arbitrarily long (#9920). The record ends with the
   * lease. Optional so a hand-written lease that does not track survivors stays valid.
   */
  markHeldByUnkillableProcess?(pid: number | undefined): void;
  release(): void;
}

export interface VirtualDeviceLifecycleCoordinator {
  isReserved(identity: VirtualDeviceLifecycleIdentity): boolean;
  reserve(
    identity: VirtualDeviceLifecycleIdentity,
    options: VirtualDeviceLifecycleReservationOptions,
  ): Promise<VirtualDeviceLifecycleLease>;
}

export class DeviceLifecyclePreemptedError extends ActionableError {
  constructor(identity: VirtualDeviceLifecycleIdentity) {
    super(
      `Device lifecycle work for ${identity.platform}:${
        identity.kind === "stable" ? identity.stableId : identity.selector
      } was preempted by teardown`,
    );
    this.name = "DeviceLifecyclePreemptedError";
  }
}

interface LifecycleOwner {
  operation: VirtualDeviceLifecycleOperation;
  controller: AbortController;
  /** Set once the owner's process survived SIGKILL; `pid` is undefined when unknown. */
  unkillableHold?: { pid: number | undefined };
  release(): void;
}

interface LifecycleWaiter {
  operation: VirtualDeviceLifecycleOperation;
  controller: AbortController;
  resolve(owner: LifecycleOwner): void;
  reject(error: unknown): void;
}

interface LifecycleState {
  identity: VirtualDeviceLifecycleIdentity;
  owner?: LifecycleOwner;
  waiters: LifecycleWaiter[];
}

/** Operations that must not queue behind a device held by an unkillable process. */
const REFUSED_BEHIND_UNKILLABLE_HOLD: ReadonlySet<VirtualDeviceLifecycleOperation> = new Set([
  "start",
  "provision",
  "configure",
]);

function lifecycleIdentityKey(identity: VirtualDeviceLifecycleIdentity): string {
  return identity.kind === "stable"
    ? `${identity.platform}:stable:${identity.stableId}`
    : `${identity.platform}:selector:${identity.selector}`;
}

function stableIdentity(identity: StableVirtualDeviceIdentity): VirtualDeviceLifecycleIdentity {
  return { kind: "stable", ...identity };
}

function reservationCancellationError(
  signal: AbortSignal,
  operation: VirtualDeviceLifecycleOperation,
): unknown {
  if (signal.reason instanceof DOMException && signal.reason.name === "AbortError") {
    return new ActionableError(`Device lifecycle ${operation} cancelled`);
  }
  return signal.reason ?? new ActionableError(`Device lifecycle ${operation} cancelled`);
}

export class InMemoryVirtualDeviceLifecycleCoordinator implements VirtualDeviceLifecycleCoordinator {
  private readonly states = new Map<string, LifecycleState>();

  constructor(
    private readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout"> = defaultTimer,
  ) {}

  isReserved(identity: VirtualDeviceLifecycleIdentity): boolean {
    const state = this.states.get(lifecycleIdentityKey(identity));
    return state?.owner !== undefined || (state?.waiters.length ?? 0) > 0;
  }

  async reserve(
    identity: VirtualDeviceLifecycleIdentity,
    options: VirtualDeviceLifecycleReservationOptions,
  ): Promise<VirtualDeviceLifecycleLease> {
    let controller = new AbortController();
    const ownerByKey = new Map<string, LifecycleOwner>();
    await this.acquire(identity, options, controller, ownerByKey);
    let currentIdentity = identity;
    let currentOperation = options.operation;
    let reservationSignal = options.signal;
    let released = false;

    return {
      get signal() {
        return controller.signal;
      },
      get identity() {
        return currentIdentity;
      },
      bindCanonicalIdentity: async (canonical, revalidate) => {
        if (released) {
          throw new ActionableError("Cannot bind a released device lifecycle reservation");
        }
        const nextIdentity = stableIdentity(canonical);
        const nextKey = lifecycleIdentityKey(nextIdentity);
        if (ownerByKey.has(nextKey)) {
          currentIdentity = nextIdentity;
          return;
        }
        const mustRevalidate = this.states.get(nextKey)?.owner !== undefined;
        // Never park on another identity while owning this one. A waiter must
        // check its earlier resolution again after the canonical owner exits.
        for (const owner of ownerByKey.values()) {
          owner.release();
        }
        ownerByKey.clear();
        const owner = await this.waitForOwner(
          nextKey,
          nextIdentity,
          { ...options, operation: currentOperation, signal: reservationSignal },
          controller,
        );
        if (released) {
          owner.release();
          throw new ActionableError("Cannot bind a released device lifecycle reservation");
        }
        ownerByKey.set(nextKey, owner);
        currentIdentity = nextIdentity;
        if (mustRevalidate && currentOperation !== "teardown") {
          if (!revalidate) {
            throw new ActionableError(
              `Device identity '${canonical.stableId}' must be revalidated after waiting for its lifecycle reservation`,
            );
          }
          let resolved: StableVirtualDeviceIdentity;
          try {
            resolved = await revalidate();
          } catch (error) {
            throw toActionableError(
              error,
              `Failed to revalidate device '${canonical.stableId}' after lifecycle wait`,
            );
          }
          if (
            resolved.platform !== canonical.platform ||
            resolved.stableId !== canonical.stableId
          ) {
            throw new ActionableError(
              `Device identity changed while waiting for '${canonical.stableId}'; retry device selection`,
            );
          }
        }
      },
      transitionToTeardown: () => {
        if (released) {
          throw new ActionableError("Cannot transition a released device lifecycle reservation");
        }
        currentOperation = "teardown";
        reservationSignal = undefined;
        // A queued teardown may already have preempted the failed provision.
        // Its signal must not cancel the cleanup that now owns this reservation.
        if (controller.signal.aborted) {
          controller = new AbortController();
        }
        for (const owner of ownerByKey.values()) {
          owner.operation = "teardown";
          owner.controller = controller;
        }
      },
      markHeldByUnkillableProcess: (pid) => {
        if (released) {
          return;
        }
        for (const [key, owner] of ownerByKey) {
          owner.unkillableHold = { pid };
          this.rejectWaitersHeldByUnkillableProcess(key, pid);
        }
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        for (const owner of ownerByKey.values()) {
          owner.release();
        }
        ownerByKey.clear();
      },
    };
  }

  private rejectWaitersHeldByUnkillableProcess(key: string, pid: number | undefined): void {
    const state = this.states.get(key);
    if (!state) {
      return;
    }
    const error = this.unkillableHoldError(state.identity, pid);
    for (const waiter of [...state.waiters]) {
      if (REFUSED_BEHIND_UNKILLABLE_HOLD.has(waiter.operation)) {
        this.removeWaiter(key, state, waiter);
        waiter.reject(error);
      }
    }
  }

  private async acquire(
    identity: VirtualDeviceLifecycleIdentity,
    options: VirtualDeviceLifecycleReservationOptions,
    controller: AbortController,
    ownerByKey: Map<string, LifecycleOwner>,
  ): Promise<void> {
    const key = lifecycleIdentityKey(identity);
    if (ownerByKey.has(key)) {
      return;
    }
    const owner = await this.waitForOwner(key, identity, options, controller);
    ownerByKey.set(key, owner);
  }

  private async waitForOwner(
    key: string,
    identity: VirtualDeviceLifecycleIdentity,
    options: VirtualDeviceLifecycleReservationOptions,
    controller: AbortController,
  ): Promise<LifecycleOwner> {
    if (options.signal?.aborted) {
      throw reservationCancellationError(options.signal, options.operation);
    }
    const state = this.states.get(key) ?? { identity, waiters: [] };
    this.states.set(key, state);
    if (!state.owner) {
      return this.assignOwner(key, state, options.operation, controller);
    }
    this.assertNotHeldByUnkillableProcess(state.owner, identity, options.operation);
    const remainingMs = options.deadlineMs - this.timer.now();
    if (remainingMs <= 0) {
      throw this.timeoutError(identity, options.operation);
    }

    if (options.operation === "teardown") {
      const preempted = new DeviceLifecyclePreemptedError(identity);
      if (state.owner.operation !== "teardown") {
        state.owner.controller.abort(preempted);
      }
      // Existing waiters may have resolved this identity before queueing. An
      // explicit teardown invalidates that work, including behind another
      // teardown; transferred provision cleanup keeps its existing semantics.
      for (const waiter of [...state.waiters]) {
        if (waiter.operation !== "teardown") {
          this.removeWaiter(key, state, waiter);
          waiter.controller.abort(preempted);
          waiter.reject(preempted);
        }
      }
    }

    let timeout: NodeJS.Timeout | undefined;
    let removeAbortListener: (() => void) | undefined;
    let waiter: LifecycleWaiter | undefined;
    try {
      return await new Promise<LifecycleOwner>((resolve, reject) => {
        waiter = { operation: options.operation, controller, resolve, reject };
        if (options.operation === "teardown") {
          const firstNormal = state.waiters.findIndex(
            (candidate) => candidate.operation !== "teardown",
          );
          state.waiters.splice(firstNormal < 0 ? state.waiters.length : firstNormal, 0, waiter);
        } else {
          state.waiters.push(waiter);
        }
        const rejectAndRemove = (error: unknown) => {
          if (waiter) {
            this.removeWaiter(key, state, waiter);
          }
          reject(error);
        };
        timeout = this.timer.setTimeout(
          () => rejectAndRemove(this.timeoutError(identity, options.operation)),
          remainingMs,
        );
        const signal = options.signal;
        if (signal) {
          const abort = () =>
            rejectAndRemove(reservationCancellationError(signal, options.operation));
          if (signal.aborted) {
            abort();
          } else {
            signal.addEventListener("abort", abort, { once: true });
            removeAbortListener = () => signal.removeEventListener("abort", abort);
          }
        }
      });
    } finally {
      if (timeout) {
        this.timer.clearTimeout(timeout);
      }
      removeAbortListener?.();
    }
  }

  private assignOwner(
    key: string,
    state: LifecycleState,
    operation: VirtualDeviceLifecycleOperation,
    controller: AbortController,
  ): LifecycleOwner {
    let released = false;
    const owner: LifecycleOwner = {
      operation,
      controller,
      release: () => {
        if (released || state.owner !== owner) {
          return;
        }
        released = true;
        const next = state.waiters.shift();
        if (next) {
          next.resolve(this.assignOwner(key, state, next.operation, next.controller));
          return;
        }
        state.owner = undefined;
        this.states.delete(key);
      },
    };
    state.owner = owner;
    return owner;
  }

  private removeWaiter(key: string, state: LifecycleState, waiter: LifecycleWaiter): void {
    const index = state.waiters.indexOf(waiter);
    if (index >= 0) {
      state.waiters.splice(index, 1);
    }
    if (!state.owner && state.waiters.length === 0) {
      this.states.delete(key);
    }
  }

  private assertNotHeldByUnkillableProcess(
    owner: LifecycleOwner,
    identity: VirtualDeviceLifecycleIdentity,
    operation: VirtualDeviceLifecycleOperation,
  ): void {
    if (owner.unkillableHold && REFUSED_BEHIND_UNKILLABLE_HOLD.has(operation)) {
      throw this.unkillableHoldError(identity, owner.unkillableHold.pid);
    }
  }

  private unkillableHoldError(
    identity: VirtualDeviceLifecycleIdentity,
    pid: number | undefined,
  ): ActionableError {
    const value = identity.kind === "stable" ? identity.stableId : identity.selector;
    return new ActionableError(
      `${identity.platform} device '${value}' is held by unkillable process ` +
        `${pid ?? "(pid unknown)"}: it did not exit after SIGTERM and SIGKILL and may still hold ` +
        "the device. Terminate that process manually; the hold is released automatically " +
        "once it is gone.",
    );
  }

  private timeoutError(
    identity: VirtualDeviceLifecycleIdentity,
    operation: VirtualDeviceLifecycleOperation,
  ): ActionableError {
    const value = identity.kind === "stable" ? identity.stableId : identity.selector;
    return new ActionableError(
      `Timed out waiting to ${operation} ${identity.platform} device '${value}'`,
    );
  }
}

let defaultCoordinator: VirtualDeviceLifecycleCoordinator =
  new InMemoryVirtualDeviceLifecycleCoordinator();

export function getVirtualDeviceLifecycleCoordinator(): VirtualDeviceLifecycleCoordinator {
  return defaultCoordinator;
}

export function setVirtualDeviceLifecycleCoordinatorForTests(
  coordinator: VirtualDeviceLifecycleCoordinator,
): void {
  defaultCoordinator = coordinator;
}

export function resetVirtualDeviceLifecycleCoordinatorForTests(): void {
  defaultCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator();
}
