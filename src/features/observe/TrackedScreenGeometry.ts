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
import type { CoordinateSpace } from "../../daemon/canonicalPixels";

/**
 * The geometry and capture identity a screenshot request was initiated under. Captured at
 * request-send time and used when the response is pushed, so an intervening hierarchy cannot
 * relabel the in-flight frame with a capture it does not belong to.
 *
 * `coordinateSpace` and `nativeScale` travel with the binding for the same reason as the
 * dimensions: whether this frame's geometry is canonical pixels, and the physical threshold that
 * applies to it, are fixed when the request is initiated. An intervening hierarchy cannot relabel
 * in-flight pixels with different scale metadata.
 */
export interface ScreenGeometryBinding {
  captureSequence: number;
  width: number;
  height: number;
  coordinateSpace?: CoordinateSpace;
  nativeScale?: number;
}

/**
 * The `pushScreenshotUpdate` options a screenshot inherits from the binding taken at request
 * initiation: the capture identity AND (from #4549) the coordinate space it was captured under.
 * Kept as a free function so both platform clients derive them the same way and neither method has
 * to inline the optional-field spreads.
 */
export function screenshotBindingPushOptions(binding: ScreenGeometryBinding | undefined): {
  captureSequence?: number;
  coordinateSpace?: CoordinateSpace;
  nativeScale?: number;
} {
  return {
    captureSequence: binding?.captureSequence,
    ...(binding?.coordinateSpace ? { coordinateSpace: binding.coordinateSpace } : {}),
    ...(binding?.nativeScale === undefined ? {} : { nativeScale: binding.nativeScale }),
  };
}

export class TrackedScreenGeometry {
  private current: {
    width: number;
    height: number;
    captureSequence: number | null;
    coordinateSpace?: CoordinateSpace;
    nativeScale?: number;
  } | null = null;

  /** Current width, or null when no hierarchy has produced dimensions yet. */
  get width(): number | null {
    return this.current?.width ?? null;
  }

  /** Current height, or null when no hierarchy has produced dimensions yet. */
  get height(): number | null {
    return this.current?.height ?? null;
  }

  /**
   * True only when the daemon has been sent a hierarchy carrying the current geometry.
   */
  get isForwarded(): boolean {
    return this.bind() !== null;
  }

  /**
   * The identity and dimensions to bind to a screenshot request being initiated NOW, or null when
   * the current geometry has no forwarded capture behind it.
   *
   * Binding at initiation is what makes ordinary same-resolution navigation safe. A frame captured
   * on screen A can be pushed after a hierarchy for screen B has already been forwarded; both
   * screens have identical dimensions, so no measurement can tell them apart, and reading "the
   * current capture" at push time would label A's pixels with B's identity and let them pair. The
   * binding is taken before the request goes out, so the frame keeps the identity that was current
   * when it was requested.
   *
   * RESIDUAL: this binds at request-SEND, not at device CAPTURE. The device captures some time
   * later, so navigating to a SAME-SIZE screen inside that window still mis-pairs — B's pixels
   * carry A's identity. No client-side signal can distinguish it; closing it needs the device to
   * report the state it captured against (a CtrlProxy protocol change plus an APK/IPA re-cut), and
   * is tracked with the daemon-side frame-context validation in
   * https://github.com/kaeawc/auto-mobile/issues/4505.
   */
  bind(): ScreenGeometryBinding | null {
    const current = this.current;
    if (!current || current.captureSequence === null) {
      return null;
    }
    return {
      captureSequence: current.captureSequence,
      width: current.width,
      height: current.height,
      ...(current.coordinateSpace ? { coordinateSpace: current.coordinateSpace } : {}),
      ...(current.nativeScale === undefined ? {} : { nativeScale: current.nativeScale }),
    };
  }

  /**
   * Record geometry derived from a hierarchy. Unchanged dimensions keep whatever provenance was
   * already established; a change replaces the entry as NOT forwarded, because the daemon has not
   * yet seen a hierarchy carrying the new geometry.
   */
  update(
    width: number,
    height: number,
    coordinateSpace?: CoordinateSpace,
    nativeScale?: number,
  ): void {
    // Unusable geometry CLEARS rather than leaving the previous entry intact: keeping stale
    // forwarded dimensions here would let a later hierarchy push vouch for geometry that no longer
    // describes the device. Non-finite values are rejected for the same reason — they can only come
    // from a malformed hierarchy, and inventing provenance for them is never safe.
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      this.clear();
      return;
    }
    // The coordinate space is part of the identity: a change to it (canonical<->legacy) is a change
    // even when the numeric dimensions coincide — on a non-Display-Zoom device points*screenScale
    // and points*nativeScale are equal, so a metadata appearance/disappearance that does not move
    // the pixels must still reset provenance rather than be deduplicated away.
    if (
      this.current?.width === width &&
      this.current.height === height &&
      this.current.coordinateSpace === coordinateSpace &&
      this.current.nativeScale === nativeScale
    ) {
      return;
    }
    this.current = { width, height, captureSequence: null, coordinateSpace, nativeScale };
  }

  /**
   * Record the identity the daemon assigned to a hierarchy carrying the current geometry. Call only
   * after a successful push. A no-op when no geometry has been derived yet, so a push cannot
   * manufacture provenance for dimensions that do not exist.
   */
  markForwarded(captureSequence: number): void {
    if (this.current) {
      this.current = { ...this.current, captureSequence };
    }
  }

  /** Forget the geometry entirely, e.g. when the device connection is torn down. */
  clear(): void {
    this.current = null;
  }
}
