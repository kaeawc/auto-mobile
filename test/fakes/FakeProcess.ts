import type { ProcessLifecycleEventMap, ProcessLifecycleProcess } from "../../src/processLifecycle";

type ListenerMap = {
  [K in keyof ProcessLifecycleEventMap]: Array<(...args: ProcessLifecycleEventMap[K]) => void>;
};

/** Event-recording process double for process lifecycle tests. */
export class FakeProcess implements ProcessLifecycleProcess {
  readonly listeners: ListenerMap = {
    SIGINT: [],
    SIGTERM: [],
    SIGHUP: [],
    uncaughtException: [],
    unhandledRejection: [],
  };
  readonly exitCodes: number[] = [];

  on<K extends keyof ProcessLifecycleEventMap>(
    event: K,
    listener: (...args: ProcessLifecycleEventMap[K]) => void,
  ): unknown {
    this.listeners[event].push(listener);
    return this;
  }

  exit(code = 0): never {
    this.exitCodes.push(code);
    return undefined as never;
  }

  emit<K extends keyof ProcessLifecycleEventMap>(
    event: K,
    ...args: ProcessLifecycleEventMap[K]
  ): void {
    for (const listener of this.listeners[event]) {
      listener(...args);
    }
  }

  listenerCount(event: keyof ProcessLifecycleEventMap): number {
    return this.listeners[event].length;
  }
}
