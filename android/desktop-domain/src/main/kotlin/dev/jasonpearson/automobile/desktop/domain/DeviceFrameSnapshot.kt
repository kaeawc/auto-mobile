package dev.jasonpearson.automobile.desktop.domain

/**
 * Which pixels a [DeviceFrameSnapshot] was rendered from.
 *
 * The two sources carry different provenance guarantees, which is why the snapshot records it:
 * - [Screenshot] frames come from the daemon's observation stream and carry the daemon's own
 *   capture timestamp, so they can be paired against a hierarchy update from the same stream.
 * - [LiveVideo] frames come from the WebRTC/relay mirror. They carry no daemon timestamp, so their
 *   provenance is a client-side monotonic sequence plus the wall-clock instant the client received
 *   them — which is exactly what makes a stalled relay detectable.
 */
public enum class DeviceFrameSource {
  Screenshot,
  LiveVideo,
}

/**
 * One observation-stream screenshot update, with the provenance needed to pair it with a hierarchy
 * and to decide whether it is still fresh (issue #3348).
 *
 * @param deviceId the device the frame was captured from.
 * @param sequence client-side monotonic counter, bumped once per applied source update. Identifies
 *   *which* update this is, and orders snapshots.
 * @param captureSequence the daemon's shared capture identity for the geometry this frame reports —
 *   the id of the hierarchy its `screenWidth`/`screenHeight` were derived from. Paired by
 *   *equality* against [HierarchyFrameFacts.captureSequence]. Null on daemons that predate it,
 *   which fails control closed.
 * @param receivedAtMs the client wall-clock instant the update was applied, stamped by the client
 *   itself. Compared only against the client clock, for recency.
 * @param width reported device screen width for this frame.
 * @param height reported device screen height for this frame.
 * @param data the encoded frame bytes. Carried so a snapshot owns the PIXELS it describes, not just
 *   their dimensions: while a post-input refresh is pending the retained snapshot is what the view
 *   renders, and pulling bytes from newest-independent state would put new pixels on screen against
 *   the retained hierarchy — the half-updated frame this whole mechanism exists to prevent.
 *   Compared by identity, never by content (see [DeviceFrameSnapshot]).
 * @param coordinateSpace the unit [width]/[height] are expressed in, as the daemon declared it
 *   (issue #4550). [CoordinateSpace.Pixels] when the message carried `coordinateSpace: "px"`; null
 *   for a legacy frame that declared nothing. Travels per message rather than per session because
 *   the declaration is per message: a runner can start reporting scale metadata mid-stream.
 */
public data class ScreenshotFrameFacts(
  val deviceId: String?,
  val sequence: Long,
  val captureSequence: Long?,
  val receivedAtMs: Long,
  val width: Int,
  val height: Int,
  val data: ByteArray?,
  val coordinateSpace: CoordinateSpace? = null,
) {
  // ByteArray uses reference equality, which would make every copy of an otherwise-identical facts
  // object unequal. Identity is exactly what we want here — a snapshot is tied to the specific
  // frame buffer it was built from — so compare the reference explicitly rather than letting the
  // generated equals silently do something else.
  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is ScreenshotFrameFacts) return false
    return deviceId == other.deviceId &&
      sequence == other.sequence &&
      captureSequence == other.captureSequence &&
      receivedAtMs == other.receivedAtMs &&
      width == other.width &&
      height == other.height &&
      data === other.data &&
      coordinateSpace == other.coordinateSpace
  }

  override fun hashCode(): Int {
    var result = deviceId?.hashCode() ?: 0
    result = 31 * result + sequence.hashCode()
    result = 31 * result + (captureSequence?.hashCode() ?: 0)
    result = 31 * result + receivedAtMs.hashCode()
    result = 31 * result + width
    result = 31 * result + height
    result = 31 * result + System.identityHashCode(data)
    result = 31 * result + (coordinateSpace?.hashCode() ?: 0)
    return result
  }
}

/**
 * One observation-stream hierarchy update, with the provenance needed to pair it with a screenshot
 * (issue #3348). Field semantics match [ScreenshotFrameFacts].
 *
 * @param hierarchy the parsed hierarchy actually applied for this update. Paired into the snapshot
 *   so a tap maps through the same tree the click was hit-tested against, instead of whatever the
 *   independently-debounced view state holds at dispatch time.
 * @param rootWidth hierarchy root bounds width, or 0 when the root has no explicit bounds (the
 *   common Android accessibility-service case).
 * @param rootHeight hierarchy root bounds height, or 0 as above.
 * @param coordinateSpace the unit this update's element `bounds` (and therefore
 *   [rootWidth]/[rootHeight]) are expressed in; see
 *   [ScreenshotFrameFacts.coordinateSpace][ScreenshotFrameFacts]. Only when this AND the paired
 *   screenshot both declare [CoordinateSpace.Pixels] do the two describe one unit, which is the
 *   precondition [DeviceControlPolicy] requires before comparing absolute dimensions.
 */
public data class HierarchyFrameFacts(
  val deviceId: String?,
  val sequence: Long,
  val captureSequence: Long?,
  val receivedAtMs: Long,
  val hierarchy: ParsedHierarchy?,
  val rootWidth: Int,
  val rootHeight: Int,
  val coordinateSpace: CoordinateSpace? = null,
)

/**
 * One decoded live-mirror frame (issue #3348).
 *
 * There is no daemon timestamp here, so [receivedAtMs] is the *only* liveness signal: when the
 * relay stalls with its socket open the client keeps its last bitmap and unchanged dimensions, and
 * nothing about the pixels reveals that they are frozen. A recency bound on [receivedAtMs] does.
 */
public data class LiveFrameFacts(
  val deviceId: String?,
  val sequence: Long,
  val receivedAtMs: Long,
  val width: Int,
  val height: Int,
)

/**
 * An immutable, internally-consistent picture of one device frame, assembled *before* the UI layer
 * (issue #3348).
 *
 * This is the unit device control acts on. A click maps through exactly the snapshot it was
 * delivered with, and that snapshot travels with the tap all the way to the daemon request — so a
 * snapshot swap between click and dispatch cannot change the mapping, and no amount of racing
 * between the screenshot flow, the debounced hierarchy flow, the live-video frame, the connection
 * state and the device selection can produce a tap mapped through one source and sent against
 * another.
 *
 * Produced only by [DeviceControlPolicy.evaluate], which refuses to build one unless every
 * contributing source agrees (see that function for the exact rules).
 *
 * @param deviceId the single device every contributing source agreed on.
 * @param sequence monotonic and non-decreasing across snapshots for one session. Derived from the
 *   **observation-source counter only** (the newer of the screenshot's and hierarchy's sequences),
 *   which share one counter domain. The live frame's counter is deliberately excluded — it is a
 *   different domain, and mixing it in would make this field jump while a live frame is present and
 *   fall back when it clears. Used to answer "is this snapshot newer than the one I tapped
 *   through?"; see [liveFrameSequence] for the live frame's own provenance.
 * @param capturedAtMs client wall-clock instant of the *displayed* frame.
 * @param source which pixels are displayed ([DeviceFrameSource]).
 * @param frameWidth displayed frame width (live frame's, or the screenshot's).
 * @param frameHeight displayed frame height.
 * @param deviceWidth effective device-coordinate width used for mapping — hierarchy root bounds
 *   when present, else the observation stream's reported screen width.
 * @param deviceHeight effective device-coordinate height used for mapping.
 * @param screenshotData the encoded observation frame paired into this snapshot. Together with
 *   [hierarchy] and the geometry this makes the snapshot the single source for everything the view
 *   renders AND maps through, so a retained snapshot cannot show new pixels against an old tree.
 * @param hierarchy the hierarchy paired into this snapshot; may be null only when the update
 *   carried no parsed tree.
 * @param coordinateSpace the space the screenshot and the hierarchy AGREED on when this snapshot
 *   was built (issue #4550) — the unit of [deviceWidth]/[deviceHeight] and of every coordinate
 *   mapped through them. Bound here for the same reason [captureSequence] is: a snapshot can stay
 *   clickable after the sources it was built from have moved on (the post-input refresh retains
 *   it), and the daemon converts an incoming input coordinate using the runner's **current** scale
 *   metadata. If that metadata appears or disappears while a retained frame is still on screen, a
 *   coordinate mapped in one space would be converted as though it were in the other and land in
 *   the wrong physical place. Carrying the space lets the session notice the transition and fail
 *   closed; see `DeviceControlSession`.
 * @param captureSequence the daemon capture identity the screenshot and hierarchy agreed on.
 * @param screenshotSequence provenance of the observation screenshot this snapshot was built from.
 * @param hierarchySequence provenance of the hierarchy this snapshot was built from.
 * @param liveFrameSequence provenance of the live frame, or null when none is displayed.
 */
public data class DeviceFrameSnapshot(
  val deviceId: String,
  val sequence: Long,
  val capturedAtMs: Long,
  val source: DeviceFrameSource,
  val frameWidth: Int,
  val frameHeight: Int,
  val deviceWidth: Int,
  val deviceHeight: Int,
  val screenshotData: ByteArray?,
  val hierarchy: ParsedHierarchy?,
  val coordinateSpace: CoordinateSpace?,
  val captureSequence: Long,
  val screenshotSequence: Long,
  val hierarchySequence: Long,
  val liveFrameSequence: Long?,
) {
  /**
   * The device-coordinate bounds a click through this snapshot must be mapped with. Callers build
   * their [DeviceScreenGeometry] from these rather than from live view state, which is what makes
   * an equal-aspect resolution change unable to mis-scale a tap.
   */
  public val mappingBounds: Pair<Int, Int>
    get() = deviceWidth to deviceHeight

  // [screenshotData] is a ByteArray, so the generated equals would compare it by reference while
  // the generated hashCode would too — consistent, but easy to misread. Spell it out: a snapshot
  // is identified by its provenance, and two snapshots with the same sequences ARE the same
  // snapshot regardless of buffer identity.
  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is DeviceFrameSnapshot) return false
    return deviceId == other.deviceId &&
      sequence == other.sequence &&
      captureSequence == other.captureSequence &&
      screenshotSequence == other.screenshotSequence &&
      hierarchySequence == other.hierarchySequence &&
      liveFrameSequence == other.liveFrameSequence
  }

  override fun hashCode(): Int {
    var result = deviceId.hashCode()
    result = 31 * result + sequence.hashCode()
    result = 31 * result + captureSequence.hashCode()
    result = 31 * result + screenshotSequence.hashCode()
    result = 31 * result + hierarchySequence.hashCode()
    result = 31 * result + (liveFrameSequence?.hashCode() ?: 0)
    return result
  }
}
