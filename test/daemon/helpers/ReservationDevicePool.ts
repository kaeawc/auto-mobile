import type { Mutex } from "async-mutex";
import { DevicePool } from "../../../src/daemon/devicePool";
import type { DeviceRehydrationReservation } from "../../../src/daemon/deviceReservations";

/**
 * A real `DevicePool` whose restart-handoff reservations, assignment lock and owner lookup are
 * reachable through named test seams. Build it where the daemon builds its pool, e.g. by
 * replacing `DevicePool.create` while the daemon is constructed.
 */
export class ReservationDevicePool extends DevicePool {
  /** Live view of the devices held for sessions that a restart is still recovering. */
  get reservations(): Map<string, DeviceRehydrationReservation> {
    return this.rehydrationReservations;
  }

  /** The lock every device assignment holds. */
  get assignmentLock(): Mutex {
    return this.assignmentMutex;
  }

  hasConnectedOwner(...args: Parameters<DevicePool["hasConnectedMcpSessionOwner"]>): boolean {
    return this.hasConnectedMcpSessionOwner(...args);
  }
}
