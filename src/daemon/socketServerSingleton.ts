import { AuxiliarySocketHeldError } from "./AuxiliarySocketHeldError";
import { AuxiliarySocketBindConflict } from "./auxiliarySocketAvailability";
/** The module wrappers retain failed starts/closes and clear only after close succeeds. */
export interface SocketServerLifecycle {
  isListening(): boolean;
  start(): Promise<void>;
  close(): Promise<void>;
}

export class SocketServerSingleton<T extends SocketServerLifecycle> {
  instance: T | null = null;

  async start(create: () => T): Promise<T> {
    if (!this.instance) {
      this.instance = create();
    }
    if (!this.instance.isListening()) {
      try {
        await this.instance.start();
      } catch (error) {
        // A pre-bind refusal has no listener to retain or close. Consumers already
        // treat a null singleton as unavailable; never expose the incumbent.
        if (
          error instanceof AuxiliarySocketBindConflict ||
          error instanceof AuxiliarySocketHeldError
        ) {
          this.instance = null;
        }
        throw error;
      }
    }
    return this.instance;
  }

  async stop(): Promise<void> {
    if (!this.instance) {
      return;
    }
    await this.instance.close();
    this.instance = null;
  }
}
