import { SessionBrokerMaintenanceError } from "./SessionBrokerMaintenanceError";
import { SessionBrokerStoppingError } from "./SessionBrokerStoppingError";

/** Register before invoking work, including the observation await before an expiry drain. */
export function trackPoolOperation<T>(
  operations: Set<Promise<unknown>>,
  operation: () => Promise<T>,
): Promise<T> {
  const pending = Promise.resolve()
    .then(operation)
    .finally(() => operations.delete(pending));
  operations.add(pending);
  return pending;
}

/** Serializes snapshot cleanup after already-admitted preparations and pool operations settle. */
export class AvdSnapshotCleanupFence {
  private running = false;
  private activeRun: Promise<unknown> | undefined;

  constructor(
    private readonly broker: {
      isStopping(): boolean;
      preparations(): Iterable<Promise<unknown>>;
      poolOperations(): Iterable<Promise<unknown>>;
    },
  ) {}

  get inProgress(): boolean {
    return this.running;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.broker.isStopping()) {
      throw new SessionBrokerStoppingError();
    }
    if (this.running) {
      throw new SessionBrokerMaintenanceError();
    }
    this.running = true;
    const pending = this.runAfterPreparations(operation);
    this.activeRun = pending;
    return pending;
  }

  /** Shutdown retains host ownership until the entire admitted cleanup run has settled. */
  async join(): Promise<void> {
    await Promise.allSettled(this.activeRun ? [this.activeRun] : []);
  }

  private async runAfterPreparations<T>(operation: () => Promise<T>): Promise<T> {
    try {
      // Admission closes synchronously in run(), so neither iterable can gain new work.
      // Join the whole sweep: it can reach the destruction queue after its observation await.
      await Promise.allSettled([...this.broker.preparations(), ...this.broker.poolOperations()]);
      if (this.broker.isStopping()) {
        throw new SessionBrokerStoppingError();
      }
      return await operation();
    } finally {
      this.running = false;
      this.activeRun = undefined;
    }
  }
}
