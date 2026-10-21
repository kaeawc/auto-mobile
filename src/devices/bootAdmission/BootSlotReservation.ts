import { AsyncLocalStorage } from "node:async_hooks";
import { ActionableError } from "../../models/ActionableError";
import type { BootSlotReservation } from "../../models/IosBootInstrumentation";

export type {
  BootAdmissionReason,
  BootCapacityReserver,
  BootReservationOptions,
  BootSlotReservation,
} from "../../models/IosBootInstrumentation";

interface PendingBoot<T> {
  active: boolean;
  consume: (deviceId?: string) => T;
}

/** Per-gate async scope carries the admission through in-process tool invocation, never over MCP. */
export class BootReservationScope<T> {
  private readonly scope = new AsyncLocalStorage<PendingBoot<T>>();

  hasPending(): boolean {
    return this.scope.getStore()?.active === true;
  }

  take(deviceId?: string): T | undefined {
    const pending = this.scope.getStore();
    if (!pending?.active) {
      return undefined;
    }
    pending.active = false;
    return pending.consume(deviceId);
  }

  hold(
    consume: (deviceId?: string) => T,
    release: () => void,
    markReplacedDeviceGone: () => void = () => {},
  ): BootSlotReservation {
    const pending: PendingBoot<T> = { active: true, consume };
    return {
      run: async (operation) => {
        if (!pending.active) {
          throw new ActionableError("Boot reservation was already consumed or released");
        }
        let succeeded = false;
        try {
          const result = await this.scope.run(pending, operation);
          succeeded = true;
          return result;
        } finally {
          if (!succeeded && pending.active) {
            pending.active = false;
            release();
          }
        }
      },
      markReplacedDeviceGone: () => {
        if (pending.active) {
          markReplacedDeviceGone();
        }
      },
      release: () => {
        if (pending.active) {
          pending.active = false;
          release();
        }
      },
    };
  }
}
