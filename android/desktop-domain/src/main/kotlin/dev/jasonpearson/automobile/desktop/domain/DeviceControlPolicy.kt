package dev.jasonpearson.automobile.desktop.domain

import kotlin.math.abs

/** Why device control is not available for the current sources. */
public enum class DeviceControlBlockReason {
  /** The host did not opt in (the IDE plugin never does — it stays inspector-only). */
  NotEnabled,
  /** Mock/fake data is being rendered; there is no real device to actuate. */
  NotRealDeviceMode,
  /** No device is explicitly selected, so the daemon would be free to pick one the user did not. */
  NoDeviceSelected,
  /** The connected transport cannot carry daemon input. */
  TransportCannotCarryInput,
  /** The observation stream is down, so whatever is on screen is a frozen mirror. */
  ObservationStreamDisconnected,
  /** No screenshot and/or hierarchy has been applied yet. */
  NoFrame,
  /** A contributing source belongs to a different device than the selection. */
  DeviceMismatch,
  /**
   * The screenshot and the hierarchy do not describe the same device capture: their daemon
   * [captureSequence][ScreenshotFrameFacts.captureSequence] ids differ. This is the check that
   * catches an equal-aspect resolution change, which neither a dimension comparison nor an elapsed
   * time window can.
   */
  UnpairedHierarchy,

  /**
   * The daemon did not stamp a capture identity on its observation messages, so the screenshot and
   * hierarchy cannot be proven to describe the same device state. Control fails closed rather than
   * guessing.
   */
  CaptureIdentityUnavailable,
  /**
   * One or both contributing messages omitted the device-authored frame context. Older runners
   * remain inspector-only rather than allowing control with an unprovable UI identity.
   */
  FrameContextUnavailable,
  /** Screenshot and hierarchy frame contexts differ, so they cannot describe one UI state. */
  FrameContextMismatch,
  /**
   * A contributing message declared a [CoordinateSpace] this client does not implement
   * (issue #4550).
   *
   * Distinct from a message that declares nothing: an ABSENT field is the legacy point-space
   * fallback, whose geometry and input-unit semantics this client knows exactly. A DECLARED but
   * unknown space is a forward-compatibility failure — the client can know neither what the
   * reported bounds mean nor what unit the daemon's input endpoints expect for that device — so
   * control fails closed instead of guessing that it resembles the legacy space.
   *
   * Independent of [RotationMismatch]: a frame is actionable only when its rotation provenance AND
   * its coordinate space are both current, so the two gates block separately and stay named
   * separately.
   */
  UnsupportedCoordinateSpace,
  /** Screenshot and hierarchy originated while the device had different rotations. */
  RotationMismatch,
  /** The displayed frame is older than the freshness bound for its source. */
  StaleFrame,
  /** The displayed screenshot and the mapping bounds disagree geometrically. */
  GeometryMismatch,

  /**
   * A live mirror frame is the displayed surface and its dimensions do not match the mapping bounds
   * exactly. Live frames carry no capture identity, so an exact dimension match is the only
   * available proof that they describe the same screen; anything else — including a uniform scale,
   * which an aspect check would accept — could mis-scale a tap. See [DeviceControlPolicy.evaluate].
   */
  LiveFrameGeometryUnverifiable,
}

/** The outcome of [DeviceControlPolicy.evaluate]. */
public sealed interface DeviceControlDecision {
  /**
   * Control is available, and every click must be mapped and dispatched through [snapshot] — not
   * through whatever view state wins the race by dispatch time.
   */
  public data class Available(val snapshot: DeviceFrameSnapshot) : DeviceControlDecision

  /** Control is unavailable; the view must fall back to inspector mode. */
  public data class Blocked(val reason: DeviceControlBlockReason) : DeviceControlDecision

  /** The snapshot when control is available, else null. */
  public val snapshotOrNull: DeviceFrameSnapshot?
    get() = (this as? Available)?.snapshot

  /** True when a click may be forwarded to the device. */
  public val isAvailable: Boolean
    get() = this is Available
}

/**
 * The host/transport facts device control depends on, alongside the frame sources. Everything the
 * decision needs, so the decision itself is a pure function of its inputs.
 */
public data class DeviceControlInputs(
  val enabled: Boolean,
  val realDeviceMode: Boolean,
  val selectedDeviceId: String?,
  val transportSupportsInput: Boolean,
  val observationStreamConnected: Boolean,
  val screenshot: ScreenshotFrameFacts?,
  val hierarchy: HierarchyFrameFacts?,
  val liveFrame: LiveFrameFacts?,
)

/**
 * Decides whether client device control may act on the current sources, and if so assembles the one
 * [DeviceFrameSnapshot] every click must map and dispatch through (issue #3348).
 *
 * This replaces the growing set of point-gates [#3347](https://github.com/kaeawc/auto-mobile)
 * shipped with: device-id equality (screenshot **and** hierarchy), stream liveness, frame
 * generation and aspect-ratio consistency were each added in response to one discovered
 * disagreement between unsynchronized sources. Two disagreements are undetectable by comparing
 * dimensions at all:
 * - an **equal-aspect resolution change** (1080x2340 -> 720x1560) passes any aspect comparison
 *   while the mapping still runs through the stale hierarchy's absolute bounds, and
 * - a **stalled live relay** keeps its socket, its state and its last bitmap, so its dimensions
 *   never change while the user clicks frozen content.
 *
 * Both require knowing *which frame* the pixels came from, so this policy decides on provenance: a
 * shared daemon **capture identity** pairs the screenshot with the hierarchy whose geometry it
 * reports, and a client-clock recency bound retires a frame whose source stopped producing. No
 * comparison here mixes clocks — the only time values used are client-stamped receive instants,
 * compared against the client's own `nowMs`.
 *
 * Pure and Compose-free: `nowMs` is passed in, so tests drive it deterministically with no real
 * timers.
 */
public object DeviceControlPolicy {

  /**
   * How old the displayed observation screenshot may be, on the client clock. Bounds the "the
   * daemon stopped pushing but never disconnected" case that stream liveness alone does not cover.
   */
  public const val SCREENSHOT_MAX_AGE_MS: Long = 5_000L

  /**
   * How old the displayed live-mirror frame may be, on the client clock. A relay stalled in a
   * blocking read keeps [DeviceFrameSource.LiveVideo] pixels on screen indefinitely with unchanged
   * dimensions; this bound is the only thing that retires them. Well above a frame interval at any
   * plausible mirror frame rate, so an ordinary hiccup does not drop control.
   */
  public const val LIVE_FRAME_MAX_AGE_MS: Long = 1_000L

  /**
   * Relative aspect-ratio tolerance for the LEGACY branch of [isGeometryConsistent].
   *
   * Only reachable for frames that declare no [CoordinateSpace]; a `"px"` frame is compared
   * exactly. See [isGeometryConsistent] for why the tolerance existed at all.
   */
  private const val GEOMETRY_ASPECT_TOLERANCE = 0.05f

  /**
   * Evaluate control availability for [inputs] at client wall-clock [nowMs].
   *
   * Checks run cheapest-and-most-decisive first; the first failure short-circuits with its reason,
   * so the caller can surface *why* control is unavailable rather than only that it is. Every path
   * that is not [DeviceControlDecision.Available] must fall back to inspector mode — control fails
   * closed in every condition.
   */
  public fun evaluate(inputs: DeviceControlInputs, nowMs: Long): DeviceControlDecision {
    if (!inputs.enabled) return blocked(DeviceControlBlockReason.NotEnabled)
    if (!inputs.realDeviceMode) return blocked(DeviceControlBlockReason.NotRealDeviceMode)
    val selected =
      inputs.selectedDeviceId ?: return blocked(DeviceControlBlockReason.NoDeviceSelected)
    if (!inputs.transportSupportsInput) {
      return blocked(DeviceControlBlockReason.TransportCannotCarryInput)
    }
    if (!inputs.observationStreamConnected) {
      return blocked(DeviceControlBlockReason.ObservationStreamDisconnected)
    }

    val screenshot = inputs.screenshot ?: return blocked(DeviceControlBlockReason.NoFrame)
    val hierarchy = inputs.hierarchy ?: return blocked(DeviceControlBlockReason.NoFrame)
    if (screenshot.width <= 0 || screenshot.height <= 0) {
      return blocked(DeviceControlBlockReason.NoFrame)
    }

    // Every contributing source must belong to the selected device. The live frame is included
    // because it is what the user actually clicks when present.
    if (screenshot.deviceId != selected || hierarchy.deviceId != selected) {
      return blocked(DeviceControlBlockReason.DeviceMismatch)
    }
    val liveFrame = inputs.liveFrame?.takeIf { it.width > 0 && it.height > 0 }
    if (liveFrame != null && liveFrame.deviceId != selected) {
      return blocked(DeviceControlBlockReason.DeviceMismatch)
    }

    // "Can these messages be interpreted at all" precedes "do they describe the same capture", so
    // this runs before provenance pairing. A DECLARED but unknown space means this client can read
    // neither the geometry nor the unit the daemon's input endpoints expect for the device, so
    // there is nothing to pair and nothing safe to dispatch. An ABSENT declaration is untouched:
    // that is the legacy point-space fallback, and it continues below.
    if (
      screenshot.coordinateSpace is CoordinateSpace.Unrecognized ||
        hierarchy.coordinateSpace is CoordinateSpace.Unrecognized
    ) {
      return blocked(DeviceControlBlockReason.UnsupportedCoordinateSpace)
    }

    // Provenance pairing by SHARED CAPTURE IDENTITY, not elapsed time.
    //
    // The daemon assigns a monotonic id per device on every hierarchy it pushes, and echoes that
    // id on every screenshot whose reported screenWidth/screenHeight were derived from that
    // hierarchy. Equal ids therefore mean "these two messages describe the same captured device
    // state" — a fact, not an inference.
    //
    // Elapsed time cannot do this job. After an aspect-preserving resolution change
    // (1080x2340 -> 720x1560) the new screenshot and the not-yet-applied older hierarchy are
    // milliseconds apart and identical in aspect, so any window wide enough for normal streaming
    // also admits the mis-scaled pair.
    //
    // Neither can a dimension comparison, at any strictness. Canonical pixels do make the exact
    // comparison below meaningful, and it does reject a resolution change — but two captures of
    // DIFFERENT content at the SAME resolution are dimensionally identical, and that is the
    // ordinary case (navigation). Identity is the only thing that separates them.
    //
    // The messages' `timestamp` fields are deliberately unused: the hierarchy's originates on the
    // DEVICE (its own wall clock, forwarded unchanged) while the screenshot's is stamped by the
    // DAEMON, so their difference is dominated by clock skew rather than by staleness.
    val captureSequence = screenshot.captureSequence
    if (captureSequence == null || hierarchy.captureSequence == null) {
      return blocked(DeviceControlBlockReason.CaptureIdentityUnavailable)
    }
    val frameContext = screenshot.frameContext
    if (frameContext == null || hierarchy.frameContext == null) {
      return blocked(DeviceControlBlockReason.FrameContextUnavailable)
    }
    if (frameContext != hierarchy.frameContext) {
      return blocked(DeviceControlBlockReason.FrameContextMismatch)
    }

    // Rotation is capture-time provenance, distinct from pixel orientation. iOS can deliver
    // native-portrait screenshot pixels for a landscape device, so geometry intentionally accepts
    // a rotated image below. What must agree here is the device orientation at which each source
    // was captured; a missing value from an older daemon is not evidence and fails closed. This
    // precedes capture pairing because a hierarchy-first rotation update has a new capture identity
    // while the displayed screenshot still has the old orientation; retention must not leave that
    // frame interactive during the ensuing screenshot capture.
    val screenshotRotation = screenshot.rotation
    val hierarchyRotation = hierarchy.rotation
    if (
      screenshotRotation == null ||
        hierarchyRotation == null ||
        screenshotRotation !in 0..3 ||
        hierarchyRotation !in 0..3 ||
        screenshotRotation != hierarchyRotation
    ) {
      return blocked(DeviceControlBlockReason.RotationMismatch)
    }

    if (captureSequence != hierarchy.captureSequence) {
      return blocked(DeviceControlBlockReason.UnpairedHierarchy)
    }

    // Effective mapping bounds: the SAME rule the renderer uses — hierarchy root bounds when the
    // root reports any, else the observation stream's reported screen size (Android accessibility
    // roots are commonly (0,0,0,0)).
    val deviceWidth = hierarchy.rootWidth.takeIf { it > 0 } ?: screenshot.width
    val deviceHeight = hierarchy.rootHeight.takeIf { it > 0 } ?: screenshot.height

    if (nowMs - screenshot.receivedAtMs > SCREENSHOT_MAX_AGE_MS) {
      return blocked(DeviceControlBlockReason.StaleFrame)
    }
    if (liveFrame != null && nowMs - liveFrame.receivedAtMs > LIVE_FRAME_MAX_AGE_MS) {
      // The relay is stalled: same socket, same state, same bitmap, same dimensions. Only recency
      // reveals it.
      return blocked(DeviceControlBlockReason.StaleFrame)
    }
    if (
      liveFrame != null &&
        (liveFrame.rotation == null ||
          liveFrame.rotation !in 0..3 ||
          liveFrame.rotation != screenshotRotation)
    ) {
      // A WebRTC frame has no observation capture identity, so its own rotation provenance is the
      // only evidence that the displayed pixels still match the hierarchy bounds. In particular,
      // 180-degree rotation keeps dimensions unchanged and defeats the exact-geometry check below.
      return blocked(DeviceControlBlockReason.RotationMismatch)
    }

    val frameWidth = liveFrame?.width ?: screenshot.width
    val frameHeight = liveFrame?.height ?: screenshot.height

    // Resolved ONCE, then both compared against and bound into the snapshot, so the space a frame
    // is
    // judged in and the space it is later dispatched in cannot diverge.
    val pairedSpace = pairedCoordinateSpace(screenshot, hierarchy)
    val pairedNativeScale = pairedNativeScale(screenshot, hierarchy, pairedSpace)
    if (pairedSpace == CoordinateSpace.Pixels && pairedNativeScale == null) {
      return blocked(DeviceControlBlockReason.GeometryMismatch)
    }

    if (liveFrame != null) {
      // The live mirror carries NO capture identity — it is a separate WebRTC transport with no
      // link to the observation stream's captures — so none of the pairing above says anything
      // about these pixels. All that is left is their dimensions, and an aspect check accepts any
      // uniform scale: a fresh 720x1560 mirror frame passes against 1080x2340 mapping bounds, and
      // a center click is then sent as (540,1170) instead of (360,780).
      //
      // So require the mirror's pixels to match the mapping bounds EXACTLY. That excludes a scale
      // change, which is the whole failure mode. This check has always been exact and is unchanged
      // by canonical pixels — what canonical pixels changed is that it can now SUCCEED on iOS. A
      // px-space hierarchy reports the same physical pixels the mirror decodes, so an iOS live
      // frame matches its mapping bounds instead of being permanently unverifiable against
      // point-space bounds. A legacy (undeclared) iOS frame still fails here, and blocking is
      // still the right answer for it: losing control while mirroring is acceptable, sending a
      // mis-scaled tap to real hardware is not.
      //
      // Giving live frames a real identity needs WebRTC-side plumbing; tracked under #1099.
      if (frameWidth != deviceWidth || frameHeight != deviceHeight) {
        return blocked(DeviceControlBlockReason.LiveFrameGeometryUnverifiable)
      }
    } else if (
      !isGeometryConsistent(
        frameWidth = frameWidth,
        frameHeight = frameHeight,
        deviceWidth = deviceWidth,
        deviceHeight = deviceHeight,
        // A polled screenshot may arrive in native pixel orientation (notably iOS) and the
        // renderer
        // rotates it, so an orientation difference there is expected.
        allowRotation = true,
        coordinateSpace = pairedSpace,
      )
    ) {
      return blocked(DeviceControlBlockReason.GeometryMismatch)
    }

    return DeviceControlDecision.Available(
      DeviceFrameSnapshot(
        deviceId = selected,
        // Ordered by the OBSERVATION-source counter alone. The live frame's sequence comes from
        // a
        // different counter domain entirely (a per-mirror-connection counter), so folding it in
        // with maxOf would let the snapshot sequence jump to the mirror's value while a live
        // frame
        // is present and then go BACKWARDS when it clears — breaking both the monotonicity this
        // field promises and the refresh policy's "strictly greater sequence" settle condition.
        // The live frame's provenance is carried separately in liveFrameSequence.
        sequence = maxOf(screenshot.sequence, hierarchy.sequence),
        capturedAtMs = liveFrame?.receivedAtMs ?: screenshot.receivedAtMs,
        source =
          if (liveFrame != null) DeviceFrameSource.LiveVideo else DeviceFrameSource.Screenshot,
        frameWidth = frameWidth,
        frameHeight = frameHeight,
        deviceWidth = deviceWidth,
        deviceHeight = deviceHeight,
        screenshotData = screenshot.data,
        hierarchy = hierarchy.hierarchy,
        // Bind the agreed space to the snapshot, exactly as captureSequence is bound: a
        // snapshot
        // outlives the facts it was built from (the post-input refresh retains it), and the
        // unit
        // its
        // coordinates are in must travel with it rather than be re-derived at dispatch time.
        coordinateSpace = pairedSpace,
        captureSequence = captureSequence,
        frameContext = frameContext,
        rotation = screenshotRotation,
        screenshotSequence = screenshot.sequence,
        hierarchySequence = hierarchy.sequence,
        liveFrameSequence = liveFrame?.sequence,
        nativeScale = pairedNativeScale,
      )
    )
  }

  /**
   * Whether [snapshot] is still inside the freshness bound for the source it was displayed from.
   *
   * Exposed so a caller that RETAINS a snapshot (see the post-input refresh policy) can apply the
   * same bound to what it retains. Retention must never outlive freshness: a frame held for the
   * refresh wait is still a frame the user can click, so it has to age out exactly as the live
   * decision would age it out.
   */
  public fun isSnapshotFresh(snapshot: DeviceFrameSnapshot, nowMs: Long): Boolean {
    val maxAgeMs =
      when (snapshot.source) {
        DeviceFrameSource.LiveVideo -> LIVE_FRAME_MAX_AGE_MS
        DeviceFrameSource.Screenshot -> SCREENSHOT_MAX_AGE_MS
      }
    return nowMs - snapshot.capturedAtMs <= maxAgeMs
  }

  /**
   * The coordinate space the screenshot and the hierarchy AGREE on, or null when they do not
   * (issue #4550).
   *
   * All-or-nothing on purpose, matching the daemon's own rule: a comparison between the two
   * messages' dimensions is only meaningful when both are the same unit, and one declared `"px"`
   * message paired with one undeclared message is exactly the mixed-unit state the exact check must
   * not be applied to. In practice the two travel together — the daemon binds a screenshot's
   * declaration at request initiation from the hierarchy that was current — so a disagreement means
   * a transition is in flight, and a transition should take the conservative path.
   */
  private fun pairedCoordinateSpace(
    screenshot: ScreenshotFrameFacts,
    hierarchy: HierarchyFrameFacts,
  ): CoordinateSpace? =
    screenshot.coordinateSpace.takeIf { it != null && it == hierarchy.coordinateSpace }

  /**
   * Native scale is meaningful only for canonical-pixel frames. A controllable snapshot requires
   * both messages to carry the same finite, positive value.
   */
  private fun pairedNativeScale(
    screenshot: ScreenshotFrameFacts,
    hierarchy: HierarchyFrameFacts,
    coordinateSpace: CoordinateSpace?,
  ): Double? {
    if (coordinateSpace != CoordinateSpace.Pixels) return null
    val scale = screenshot.nativeScale ?: return null
    return scale.takeIf { it.isFinite() && it > 0.0 && it == hierarchy.nativeScale }
  }

  /**
   * Whether the displayed frame and the effective device bounds used for mapping describe a
   * geometrically-consistent view of the same screen. A renderer fits the displayed frame by its
   * own aspect ratio while mapping clicks through the device bounds, so disagreeing geometry means
   * a tap is scaled wrong.
   *
   * There are two comparison modes, selected by [coordinateSpace] — the space the frame and the
   * bounds were BOTH declared in (see [pairedCoordinateSpace]):
   * - **[CoordinateSpace.Pixels] — exact.** Both sides are canonical physical pixels, one unit, so
   *   absolute dimensions must be EQUAL. The rotation swap is still accepted, because it is a real
   *   property of the pixels rather than a units artifact: a polled screenshot can arrive in native
   *   portrait orientation while the bounds are display-oriented, and the renderer rotates it.
   *   Nothing else is: a downscale, a resolution change, and a stale-bounds pair are all rejected,
   *   where an aspect check would accept every one of them.
   * - **`null` — LEGACY aspect-only fallback**, for a daemon (or a pre-#4548 runner) that declares
   *   no space. There, iOS hierarchy bounds are logical points against a pixel screenshot, so the
   *   two sides are a uniform scale apart by construction and absolute dimensions are simply not
   *   comparable. All that can be checked is that the aspect ratios agree within
   *   [GEOMETRY_ASPECT_TOLERANCE] — which is why this path cannot catch an equal-aspect resolution
   *   change, and why provenance pairing exists. Retained only for those frames; do not extend it.
   *
   * [CoordinateSpace.Unrecognized] never reaches here from [evaluate]: a declared-but-unknown space
   * blocks control outright with [DeviceControlBlockReason.UnsupportedCoordinateSpace], because a
   * space this client cannot read is not a weaker version of the legacy space. A direct caller that
   * passes one gets the conservative aspect-only comparison, which is the safe default for a
   * geometry question but is NOT a licence to act on such a frame.
   *
   * A non-positive displayed dimension (no frame yet) is inconsistent in both modes. Non-positive
   * device dimensions mean neither source reported a size, in which case the renderer falls back to
   * the displayed frame itself and the two are consistent by construction.
   */
  public fun isGeometryConsistent(
    frameWidth: Int,
    frameHeight: Int,
    deviceWidth: Int,
    deviceHeight: Int,
    allowRotation: Boolean = true,
    coordinateSpace: CoordinateSpace? = null,
  ): Boolean {
    if (frameWidth <= 0 || frameHeight <= 0) return false
    if (deviceWidth <= 0 || deviceHeight <= 0) return true
    if (coordinateSpace == CoordinateSpace.Pixels) {
      val matchesExactly = frameWidth == deviceWidth && frameHeight == deviceHeight
      if (!allowRotation) return matchesExactly
      return matchesExactly || (frameWidth == deviceHeight && frameHeight == deviceWidth)
    }
    val frameAspect = frameWidth.toFloat() / frameHeight.toFloat()
    val deviceAspect = deviceWidth.toFloat() / deviceHeight.toFloat()
    val matchesDirect = abs(frameAspect - deviceAspect) <= GEOMETRY_ASPECT_TOLERANCE * deviceAspect
    if (!allowRotation) return matchesDirect
    val rotatedAspect = 1f / deviceAspect
    val matchesRotated =
      abs(frameAspect - rotatedAspect) <= GEOMETRY_ASPECT_TOLERANCE * rotatedAspect
    return matchesDirect || matchesRotated
  }

  private fun blocked(reason: DeviceControlBlockReason): DeviceControlDecision =
    DeviceControlDecision.Blocked(reason)
}
