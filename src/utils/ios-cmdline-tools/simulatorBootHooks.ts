import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";

/** Runs after AutoMobile boots or reboots a simulator; a rejection is logged, never thrown. */
export type SimulatorBootListener = (udid: string) => void | Promise<void>;

/**
 * Lets device state that lives in a simulator's launchd environment (which a boot resets) be
 * restored after every AutoMobile-initiated boot, without the boot code knowing which features
 * need it.
 */
export interface SimulatorBootHooks {
  onBooted(listener: SimulatorBootListener): () => void;
  notifyBooted(udid: string): void;
}

export class DefaultSimulatorBootHooks implements SimulatorBootHooks {
  private readonly listeners = new Set<SimulatorBootListener>();

  onBooted(listener: SimulatorBootListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Listeners run in the background: a boot never waits on, or fails because of, a listener. */
  notifyBooted(udid: string): void {
    for (const listener of this.listeners) {
      void Promise.resolve()
        .then(() => listener(udid))
        .catch((error: unknown) => {
          logger.warn(`Simulator boot listener failed for ${udid}: ${errorMessage(error)}`, error);
        });
    }
  }
}

export const simulatorBootHooks: SimulatorBootHooks = new DefaultSimulatorBootHooks();
