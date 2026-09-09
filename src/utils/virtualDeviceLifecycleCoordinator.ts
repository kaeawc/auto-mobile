import { ActionableError, type Platform } from "../models";
import { defaultTimer, type Timer } from "./SystemTimer";

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
  bindCanonicalIdentity(identity: StableVirtualDeviceIdentity): Promise<void>;
  transitionToTeardown(): void;
  release(): void;
}

export interface VirtualDeviceLifecycleCoordinator {
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
  release(): void;
}

interface LifecycleWaiter {
  operation: VirtualDeviceLifecycleOperation;
  controller: AbortController;
  resolve(owner: LifecycleOwner): void;
  reject(error: unknown): void;
}

interface LifecycleState {
  owner?: LifecycleOwner;
  waiters: LifecycleWaiter[];
}

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
      bindCanonicalIdentity: async (canonical) => {
        if (released) {
          throw new ActionableError("Cannot bind a released device lifecycle reservation");
        }
        const nextIdentity = stableIdentity(canonical);
        const previousKeys = [...ownerByKey.keys()];
        await this.acquire(
          nextIdentity,
          { ...options, operation: currentOperation, signal: reservationSignal },
          controller,
          ownerByKey,
        );
        currentIdentity = nextIdentity;
        const nextKey = lifecycleIdentityKey(nextIdentity);
        for (const key of previousKeys) {
          if (key !== nextKey) {
            ownerByKey.get(key)?.release();
            ownerByKey.delete(key);
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
    const state = this.states.get(key) ?? { waiters: [] };
    this.states.set(key, state);
    if (!state.owner) {
      return this.assignOwner(key, state, options.operation, controller);
    }

    if (options.operation === "teardown" && state.owner.operation !== "teardown") {
      state.owner.controller.abort(new DeviceLifecyclePreemptedError(identity));
    }

    const remainingMs = options.deadlineMs - this.timer.now();
    if (remainingMs <= 0) {
      throw this.timeoutError(identity, options.operation);
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
