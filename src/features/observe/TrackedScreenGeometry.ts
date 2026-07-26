/**
 * The device screen geometry a CtrlProxy client derives from hierarchies, together with whether the
 * daemon has actually SEEN a hierarchy carrying it (issue #3348).
 *
 * Screenshot messages declare these dimensions, and the daemon attaches a capture identity to a
 * frame only when the declaring client vouches that the geometry came from a hierarchy it forwarded
 * — that identity is what lets a control client prove a screenshot and a hierarchy describe the
 * same device state before mapping a tap through them.
 *
 * The vouch has to reflect reality, not intent. A hierarchy can update this cache and then never
 * reach the daemon: the push may be suppressed for an explicit initial-frame request, the stream
 * server may not be running, or the push may throw. Claiming provenance in those cases would let
 * the daemon stamp an older capture's identity onto fresh pixels, which is the mis-pairing the
 * identity exists to prevent. So [markForwarded] is the ONLY thing that can set the flag, and it is
 * called only after a push succeeds; any change of geometry clears it again.
 *
 * Both the Android and iOS clients own one of these, so the rule is identical on both platforms by
 * construction rather than by two parallel implementations agreeing.
 */
export class TrackedScreenGeometry {
  private current: { width: number; height: number; forwarded: boolean } | null = null;

  /** Current width, or null when no hierarchy has produced dimensions yet. */
  get width(): number | null {
    return this.current?.width ?? null;
  }

  /** Current height, or null when no hierarchy has produced dimensions yet. */
  get height(): number | null {
    return this.current?.height ?? null;
  }

  /**
   * True only when the daemon has been sent a hierarchy carrying the current geometry. Callers pass
   * this to `pushScreenshotUpdate` as the capture-provenance claim; false means the daemon omits
   * the capture identity and a control client fails closed, which is always the safe outcome.
   */
  get isForwarded(): boolean {
    return this.current?.forwarded === true;
  }

  /**
   * Record geometry derived from a hierarchy. Unchanged dimensions keep whatever provenance was
   * already established; a change replaces the entry as NOT forwarded, because the daemon has not
   * yet seen a hierarchy carrying the new geometry.
   */
  update(width: number, height: number): void {
    if (width <= 0 || height <= 0) {
      return;
    }
    if (this.current?.width === width && this.current.height === height) {
      return;
    }
    this.current = { width, height, forwarded: false };
  }

  /**
   * Vouch that a hierarchy carrying the current geometry reached the daemon. Call only after a
   * successful push. A no-op when no geometry has been derived yet, so a push cannot manufacture
   * provenance for dimensions that do not exist.
   */
  markForwarded(): void {
    if (this.current) {
      this.current = { ...this.current, forwarded: true };
    }
  }

  /** Forget the geometry entirely, e.g. when the device connection is torn down. */
  clear(): void {
    this.current = null;
  }
}
