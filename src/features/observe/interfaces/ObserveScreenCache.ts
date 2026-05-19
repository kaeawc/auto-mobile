/**
 * Abstraction over the process-wide ObserveScreen cache (hierarchy +
 * screenshot stores + screenshot-job tracker). Lets non-observe code clear
 * cached state for a device without taking a direct dependency on the
 * concrete `RealObserveScreen` static.
 */
export interface ObserveScreenCache {
  /**
   * Clear cached observation state for a single device.
   */
  clearForDevice(deviceId: string): void;
}
