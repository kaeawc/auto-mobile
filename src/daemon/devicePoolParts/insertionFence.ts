/** Live shutdown state needed to decide whether discovery may publish an absent device. */
export interface InsertionFenceSources {
  intentionalShutdowns: ReadonlyMap<string, number>;
  isDeviceUnderShutdown(deviceId: string): boolean;
  isUnpooledShutdownFenced(deviceId: string): boolean;
}

export function insertionWasFenced(
  sources: InsertionFenceSources,
  deviceId: string,
  removalFence: { wasRemoved(): boolean },
  marks: { shutdownMarker: number | undefined; shutdownReserved: boolean },
): boolean {
  return (
    removalFence.wasRemoved() ||
    marks.shutdownReserved ||
    sources.isUnpooledShutdownFenced(deviceId) ||
    sources.isDeviceUnderShutdown(deviceId) ||
    marks.shutdownMarker !== sources.intentionalShutdowns.get(deviceId) ||
    marks.shutdownMarker !== undefined
  );
}
