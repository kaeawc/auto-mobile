import { SessionBrokerMaintenanceError } from "./SessionBrokerMaintenanceError";
import { SessionBrokerStoppingError } from "./SessionBrokerStoppingError";

/** Serializes snapshot cleanup after all already-admitted preparations settle. */
export class AvdSnapshotCleanupFence {
  private running = false;
  private activeRun: Promise<unknown> | undefined;

  constructor(
    private readonly broker: {
      isStopping(): boolean;
      preparations(): Iterable<Promise<unknown>>;
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
      await Promise.allSettled([...this.broker.preparations()]);
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
