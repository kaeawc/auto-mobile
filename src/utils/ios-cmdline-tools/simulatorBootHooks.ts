import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";

/** What a boot notification knows about the simulator's state before the boot. */
export interface SimulatorBootInfo {
  /**
   * The simulator was already Booted when AutoMobile ran `bootstatus -b`, so nothing reset. Absent
   * (or false) means a real boot, or a boot whose prior state was not read.
   */
  wasAlreadyBooted?: boolean;
}

/** Runs after AutoMobile boots or reboots a simulator; a rejection is logged, never thrown. */
export type SimulatorBootListener = (udid: string, info: SimulatorBootInfo) => void | Promise<void>;

/**
 * Lets device state that lives in a simulator's launchd environment (which a boot resets) be
 * restored after every AutoMobile-initiated boot, without the boot code knowing which features
 * need it.
 */
export interface SimulatorBootHooks {
  onBooted(listener: SimulatorBootListener): () => void;
  notifyBooted(udid: string, info?: SimulatorBootInfo): void;
}

export class DefaultSimulatorBootHooks implements SimulatorBootHooks {
  private readonly listeners = new Set<SimulatorBootListener>();

  onBooted(listener: SimulatorBootListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Listeners run in the background: a boot never waits on, or fails because of, a listener. */
  notifyBooted(udid: string, info: SimulatorBootInfo = {}): void {
    for (const listener of this.listeners) {
      void Promise.resolve()
        .then(() => listener(udid, info))
        .catch((error: unknown) => {
          logger.warn(`Simulator boot listener failed for ${udid}: ${errorMessage(error)}`, error);
        });
    }
  }
}

export const simulatorBootHooks: SimulatorBootHooks = new DefaultSimulatorBootHooks();
