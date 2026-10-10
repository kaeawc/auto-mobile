/**
 * Orders concurrent shows of one prototype id on one device. Each show takes a generation when it
 * starts; only the latest generation may commit its result to host status, so a slower, older
 * show finishing last cannot overwrite what the newer one already recorded.
 */
export class PrototypeCommitGenerations {
  private readonly latest = new Map<string, number>();

  begin(deviceId: string, prototypeId: string): number {
    const key = JSON.stringify([deviceId, prototypeId]);
    const generation = (this.latest.get(key) ?? 0) + 1;
    this.latest.set(key, generation);
    return generation;
  }

  isLatest(deviceId: string, prototypeId: string, generation: number): boolean {
    return this.latest.get(JSON.stringify([deviceId, prototypeId])) === generation;
  }
}
