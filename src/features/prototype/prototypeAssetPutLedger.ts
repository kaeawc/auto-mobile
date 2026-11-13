/**
 * The latest asset-cache put started per device and asset id. Cache keys are per device, so every
 * transport for one device must share a ledger: a put that fails may only drop the cached entry
 * when no newer put for the same key started since, from this or a replacement transport (#18282).
 */
export class PrototypeAssetPutLedger {
  private readonly latest = new Map<string, number>();
  private nextGeneration = 0;

  /**
   * Records a put of `id` on `serial` as the newest. The returned function settles the put once:
   * it reports whether it is still the newest for that key and releases the key if so.
   */
  begin(serial: string, id: string): () => boolean {
    const key = JSON.stringify([serial, id]);
    const generation = ++this.nextGeneration;
    this.latest.set(key, generation);
    return () => {
      if (this.latest.get(key) !== generation) {
        return false;
      }
      this.latest.delete(key);
      return true;
    };
  }
}
