/**
 * Assigns a monotonic order to completed device-discovery observations.
 *
 * This intentionally does not use wall-clock time: NTP or manual clock changes
 * can move `Date.now()` backward while a daemon is running.
 */
export interface DiscoveryObservationSequence {
  next(): number;
}

export class MonotonicDiscoveryObservationSequence implements DiscoveryObservationSequence {
  private value = 0;

  next(): number {
    this.value++;
    return this.value;
  }
}

/**
 * Process-wide ordering source shared by Android and iOS discovery clients.
 */
export const defaultDiscoveryObservationSequence: DiscoveryObservationSequence =
  new MonotonicDiscoveryObservationSequence();
