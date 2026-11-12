/**
 * Counts lookFor search swipes that moved the settled content.
 *
 * The idle poll reads the cache, so a moving list can settle on stale frames.
 * A move seen only in a stale frame is held as pending; a later fresh frame
 * that differs from the last confirmed content proves those moves happened,
 * and one that matches it discards them (#18128).
 */
export class MovedSwipeTally {
  private moved = 0;
  private pending = 0;
  private confirmedFingerprint = "";

  get count(): number {
    return this.moved;
  }

  reset(fingerprint: string): void {
    this.moved = 0;
    this.pending = 0;
    this.confirmedFingerprint = fingerprint;
  }

  /** Re-anchors confirmation on a new baseline frame without changing the count. */
  rebase(fingerprint: string): void {
    this.pending = 0;
    this.confirmedFingerprint = fingerprint;
  }

  /** Records one swipe whose content moved; a stale move counts only once confirmed. */
  recordMove(fresh: boolean, holdStale: boolean): void {
    if (fresh) {
      this.moved++;
    } else if (holdStale) {
      this.pending++;
    }
  }

  /** A fresh frame confirms or discards the pending stale moves. */
  confirm(fingerprint: string, fresh: boolean): void {
    if (!fresh || !fingerprint) {
      return;
    }
    if (this.pending > 0 && fingerprint !== this.confirmedFingerprint) {
      this.moved += this.pending;
    }
    this.rebase(fingerprint);
  }
}
