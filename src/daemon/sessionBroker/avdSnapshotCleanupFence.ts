import { SessionBrokerMaintenanceError } from "./SessionBrokerMaintenanceError";
import { SessionBrokerStoppingError } from "./SessionBrokerStoppingError";

/** Serializes snapshot cleanup after all already-admitted preparations settle. */
export class AvdSnapshotCleanupFence {
  private running = false;

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
    try {
      await Promise.allSettled([...this.broker.preparations()]);
      if (this.broker.isStopping()) {
        throw new SessionBrokerStoppingError();
      }
      return await operation();
    } finally {
      this.running = false;
    }
  }
}
