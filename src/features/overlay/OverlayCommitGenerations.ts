/**
 * Orders concurrent shows of one overlay id on one device. Each show takes a generation when it
 * starts; only the latest generation may commit its result to host status, so a slower, older
 * show finishing last cannot overwrite what the newer one already recorded.
 */
export class OverlayCommitGenerations {
  private readonly latest = new Map<string, number>();

  begin(deviceId: string, overlayId: string): number {
    const key = JSON.stringify([deviceId, overlayId]);
    const generation = (this.latest.get(key) ?? 0) + 1;
    this.latest.set(key, generation);
    return generation;
  }

  isLatest(deviceId: string, overlayId: string, generation: number): boolean {
    return this.latest.get(JSON.stringify([deviceId, overlayId])) === generation;
  }
}
