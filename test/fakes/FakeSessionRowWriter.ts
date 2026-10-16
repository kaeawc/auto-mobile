import type {
  DesiredReleaseRow,
  ReleaseRowLanded,
  SessionRowWriter,
} from "../../src/daemon/sessionRowWriter";
import type { SessionReleaseSnapshot } from "../../src/daemon/sessionManager";

/** Manually landed release desires, with no persistence or clock access. */
export class FakeSessionRowWriter implements SessionRowWriter {
  readonly desires = new Map<string, DesiredReleaseRow>();
  private readonly outcomes = new Map<string, ReturnType<typeof Promise.withResolvers<boolean>>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly listeners = new Set<(event: ReleaseRowLanded) => void | Promise<unknown>>();

  desire(uuid: string, desired: DesiredReleaseRow): void {
    if (this.desires.get(uuid)?.terminal && !desired.terminal) {
      return;
    }
    this.outcomes.get(uuid)?.resolve(false);
    this.desires.set(uuid, desired);
    this.outcomes.set(uuid, Promise.withResolvers<boolean>());
  }

  pending(uuid: string): boolean {
    return this.desires.has(uuid);
  }

  pendingSnapshot(uuid: string): SessionReleaseSnapshot | undefined {
    return this.desires.get(uuid)?.snapshot;
  }

  result(uuid: string): Promise<boolean> {
    return this.outcomes.get(uuid)?.promise ?? Promise.resolve(true);
  }

  settled(uuid: string): Promise<void> {
    if (!this.pending(uuid)) {
      return Promise.resolve();
    }
    const waiters = this.waiters.get(uuid) ?? new Set();
    this.waiters.set(uuid, waiters);
    return new Promise((resolve) => waiters.add(resolve));
  }

  async land(uuid: string, refused = false): Promise<void> {
    const desired = this.desires.get(uuid);
    if (!desired) {
      return;
    }
    this.outcomes.get(uuid)?.resolve(true);
    this.cancel(uuid, desired.snapshot);
    for (const listener of this.listeners) {
      await listener({ snapshot: desired.snapshot, late: false, refused });
    }
  }

  cancel(uuid: string, snapshot: SessionReleaseSnapshot): void {
    if (this.desires.get(uuid)?.snapshot !== snapshot) {
      return;
    }
    this.desires.delete(uuid);
    this.outcomes.get(uuid)?.resolve(false);
    this.outcomes.delete(uuid);
    for (const resolve of this.waiters.get(uuid) ?? []) {
      resolve();
    }
    this.waiters.delete(uuid);
  }

  liftTerminal(uuid: string): void {
    const desired = this.desires.get(uuid);
    if (desired?.terminal) {
      this.cancel(uuid, desired.snapshot);
    }
  }

  async drain(): Promise<void> {
    await Promise.all(Array.from(this.desires.keys(), (uuid) => this.settled(uuid)));
  }

  stop(): void {
    for (const [uuid, desired] of this.desires) {
      if (!desired.terminal) {
        this.cancel(uuid, desired.snapshot);
      }
    }
  }

  onRowLanded(listener: (event: ReleaseRowLanded) => void | Promise<unknown>): void {
    this.listeners.add(listener);
  }
}
