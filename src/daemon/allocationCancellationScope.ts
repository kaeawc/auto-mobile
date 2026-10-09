import { AsyncLocalStorage } from "node:async_hooks";

/** The slice of SessionManager a multi-device allocation needs to settle deferred cancellations. */
export interface AcquisitionCancellationSettler {
  settleDeviceAcquisitionCancellation(sessionId: string, committed: boolean): void;
}

/**
 * Holds the device-acquisition cancellation of every device a multi-device allocation creates until
 * the whole allocation commits, so a later device failing cannot leave an earlier device having
 * cancelled sessionless work for an acquisition that was rolled back (#10929).
 */
export class AllocationCancellationScope {
  private readonly pending = new Set<string>();

  constructor(private readonly settler: AcquisitionCancellationSettler) {}

  /** A device's session create committed; its cancellation now waits for the allocation. */
  hold(sessionId: string): void {
    this.pending.add(sessionId);
  }

  /** The allocation rolled this device back (e.g. a busy-retry): it cancels nothing. */
  discard(sessionId: string): void {
    if (this.pending.delete(sessionId)) {
      this.settler.settleDeviceAcquisitionCancellation(sessionId, false);
    }
  }

  /** The allocation finished: settle every device still held together. */
  settleAll(committed: boolean): void {
    for (const sessionId of [...this.pending]) {
      this.pending.delete(sessionId);
      this.settler.settleDeviceAcquisitionCancellation(sessionId, committed);
    }
  }
}

const activeScope = new AsyncLocalStorage<AllocationCancellationScope>();

export function currentAllocationCancellationScope(): AllocationCancellationScope | undefined {
  return activeScope.getStore();
}

/** Run a multi-device allocation; its devices settle together on success or failure. */
export async function withAllocationCancellationScope<T>(
  settler: AcquisitionCancellationSettler,
  allocation: () => Promise<T>,
): Promise<T> {
  const scope = new AllocationCancellationScope(settler);
  let committed = false;
  try {
    const result = await activeScope.run(scope, allocation);
    committed = true;
    return result;
  } finally {
    scope.settleAll(committed);
  }
}
