import type { Timer } from "../../src/utils/SystemTimer";
import { raceWithDeadline } from "../../src/utils/raceWithDeadline";
import {
  HostBootAdmissionRegistryError,
  type HostBootAdmissionRecord,
  type HostBootAdmissionRegistry,
  type PublishedBootAdmission,
} from "../../src/features/bootAdmission/HostBootAdmissionRegistry";

export class SharedBootAdmissionHostState {
  readonly records = new Map<string, HostBootAdmissionRecord>();
  locked = false;
  nextId = 0;
  /** Pids the host no longer runs; every other pid counts as running. */
  readonly exitedPids = new Set<number>();
  readonly waiters = new Set<() => void>();
}

/** Separate fake processes share only their host, never their local ledger. */
export class FakeHostBootAdmissionRegistry implements HostBootAdmissionRegistry {
  failReads = false;
  failPublish = false;
  failWrites = false;
  failAfterRun = false;
  lockHeldForever = false;

  constructor(
    readonly host: SharedBootAdmissionHostState,
    readonly pid: number,
    private readonly timer: Timer,
  ) {}

  async withAdmissionLock<T>(
    options: { timeoutMs: number; signal?: AbortSignal },
    fn: () => Promise<T>,
  ): Promise<T> {
    const deadline = this.timer.now() + options.timeoutMs;
    while (this.host.locked || this.lockHeldForever) {
      let wake: () => void = () => undefined;
      const available = new Promise<void>((resolve) => {
        wake = resolve;
      });
      this.host.waiters.add(wake);
      try {
        await raceWithDeadline(available, {
          timer: this.timer,
          timeoutMs: Math.max(0, deadline - this.timer.now()),
          signal: options.signal,
          label: "fake admission.lock",
          timeoutError: () =>
            new HostBootAdmissionRegistryError("timeout", "fake admission.lock timed out"),
        });
      } finally {
        this.host.waiters.delete(wake);
      }
    }
    options.signal?.throwIfAborted();
    this.host.locked = true;
    try {
      const result = await fn();
      if (this.failAfterRun) {
        throw new HostBootAdmissionRegistryError("failed", "fake admission.lock release failed");
      }
      return result;
    } finally {
      this.host.locked = false;
      for (const wake of this.host.waiters) {
        wake();
      }
    }
  }

  readPeerAdmissions(): HostBootAdmissionRecord[] {
    if (this.failReads) {
      throw new HostBootAdmissionRegistryError("failed", "fake boot registry unreadable");
    }
    for (const [id, record] of this.host.records) {
      if (this.isStale(record)) {
        this.host.records.delete(id);
      }
    }
    return [...this.host.records.values()]
      .filter((record) => record.ownerPid !== this.pid)
      .map((record) => ({ ...record }));
  }

  /** Mirrors FileHostBootAdmissionRegistry: stale records are dropped on read. */
  private isStale(record: HostBootAdmissionRecord): boolean {
    const now = this.timer.now();
    const exited = (pid: number): boolean => this.host.exitedPids.has(pid);
    if (record.handedOffUntilMs !== undefined) {
      return (
        now >= record.handedOffUntilMs ||
        (record.processId !== undefined && exited(record.ownerPid) && exited(record.processId))
      );
    }
    return (
      exited(record.ownerPid) ||
      (record.admittedUntilMs !== undefined && now >= record.admittedUntilMs)
    );
  }

  publish(
    fields: Pick<HostBootAdmissionRecord, "deviceId" | "admittedUntilMs" | "replacement"> = {},
  ): PublishedBootAdmission {
    if (this.failPublish) {
      throw new HostBootAdmissionRegistryError("failed", "fake boot registry unwritable");
    }
    const id = `admission-${++this.host.nextId}`;
    this.host.records.set(id, { id, ownerPid: this.pid, ...fields });
    let removed = false;
    return {
      clearDeviceId: () => {
        if (removed) {
          return;
        }
        this.checkWrite();
        const record = this.host.records.get(id);
        if (record) {
          delete record.deviceId;
        }
      },
      update: (update) => {
        if (removed) {
          return;
        }
        this.checkWrite();
        const record = this.host.records.get(id);
        if (record) {
          this.host.records.set(id, {
            ...record,
            ...Object.fromEntries(
              Object.entries(update).filter(([, value]) => value !== undefined),
            ),
          });
        }
      },
      remove: () => {
        if (removed) {
          return;
        }
        this.checkWrite();
        this.host.records.delete(id);
        removed = true;
      },
    };
  }

  private checkWrite(): void {
    if (this.failWrites) {
      throw new HostBootAdmissionRegistryError("failed", "fake boot registry write failed");
    }
  }
}
