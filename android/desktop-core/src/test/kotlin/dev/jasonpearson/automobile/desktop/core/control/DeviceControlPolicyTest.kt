package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.domain.CoordinateSpace
import dev.jasonpearson.automobile.desktop.domain.DeviceControlBlockReason
import dev.jasonpearson.automobile.desktop.domain.DeviceControlDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceControlInputs
import dev.jasonpearson.automobile.desktop.domain.DeviceControlPolicy
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSource
import dev.jasonpearson.automobile.desktop.domain.ElementBounds
import dev.jasonpearson.automobile.desktop.domain.HierarchyFrameFacts
import dev.jasonpearson.automobile.desktop.domain.LiveFrameFacts
import dev.jasonpearson.automobile.desktop.domain.ParsedHierarchy
import dev.jasonpearson.automobile.desktop.domain.ScreenshotFrameFacts
import dev.jasonpearson.automobile.desktop.domain.UIElementInfo
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * The device-control availability decision (issue #3348), which replaced the point-gates
 * `AutoMobileContent` assembled inline for #3347.
 *
 * All time is passed in, so these run with no timers and no device.
 */
class DeviceControlPolicyTest {

  private val device = "emulator-5554"
  private val now = 10_000L

  private fun hierarchyOf(width: Int, height: Int): ParsedHierarchy {
    val root =
      UIElementInfo(
        id = "root",
        className = "android.widget.FrameLayout",
        resourceId = null,
        text = null,
        contentDescription = null,
        bounds = ElementBounds(0, 0, width, height),
        isClickable = false,
        isEnabled = true,
        isFocused = false,
        isSelected = false,
        isScrollable = false,
        isCheckable = false,
        isChecked = false,
        children = emptyList(),
        depth = 0,
      )
    return ParsedHierarchy(root = root, elementMap = mapOf("root" to root), parentMap = emptyMap())
  }

  /** Every condition satisfied; each test flips exactly one to prove it gates. */
  private fun inputs(
    enabled: Boolean = true,
    realDeviceMode: Boolean = true,
    selectedDeviceId: String? = device,
    transportSupportsInput: Boolean = true,
    observationStreamConnected: Boolean = true,
    screenshot: ScreenshotFrameFacts? =
      ScreenshotFrameFacts(
        deviceId = device,
        sequence = 10L,
        captureSequence = 7L,
        receivedAtMs = 9_900L,
        width = 1080,
        height = 2340,
        data = null,
        rotation = 0,
      ),
    hierarchy: HierarchyFrameFacts? =
      HierarchyFrameFacts(
        deviceId = device,
        sequence = 11L,
        captureSequence = 7L,
        receivedAtMs = 9_950L,
        hierarchy = hierarchyOf(1080, 2340),
        rootWidth = 1080,
        rootHeight = 2340,
        rotation = 0,
      ),
    liveFrame: LiveFrameFacts? = null,
  ) =
    DeviceControlInputs(
      enabled = enabled,
      realDeviceMode = realDeviceMode,
      selectedDeviceId = selectedDeviceId,
      transportSupportsInput = transportSupportsInput,
      observationStreamConnected = observationStreamConnected,
      screenshot = screenshot,
      hierarchy = hierarchy,
      liveFrame = liveFrame,
    )

  private fun blockedReason(inputs: DeviceControlInputs, nowMs: Long = now) =
    (DeviceControlPolicy.evaluate(inputs, nowMs) as? DeviceControlDecision.Blocked)?.reason

  // ---- Host / transport conditions (carried over from the #3347 gate) -------

  @Test
  fun `available when every source agrees on the selected device`() {
    val decision = DeviceControlPolicy.evaluate(inputs(), now)
    val snapshot = assertNotNull(decision.snapshotOrNull)
    assertEquals(device, snapshot.deviceId)
    assertEquals(DeviceFrameSource.Screenshot, snapshot.source)
    assertEquals(1080, snapshot.deviceWidth)
    assertEquals(2340, snapshot.deviceHeight)
    // Monotonic ordering: the newest contributing source sequence.
    assertEquals(11L, snapshot.sequence)
  }

  @Test
  fun `blocked when the host did not opt in`() {
    assertEquals(DeviceControlBlockReason.NotEnabled, blockedReason(inputs(enabled = false)))
  }

  @Test
  fun `blocked in fake data mode`() {
    assertEquals(
      DeviceControlBlockReason.NotRealDeviceMode,
      blockedReason(inputs(realDeviceMode = false)),
    )
  }

  @Test
  fun `blocked with no explicitly selected device`() {
    // Switching Fake->Real keeps the socket and last frame but clears the selection; a tap then
    // would let the daemon pick a device the user never chose.
    assertEquals(
      DeviceControlBlockReason.NoDeviceSelected,
      blockedReason(inputs(selectedDeviceId = null)),
    )
  }

  @Test
  fun `blocked on an input-incapable transport`() {
    assertEquals(
      DeviceControlBlockReason.TransportCannotCarryInput,
      blockedReason(inputs(transportSupportsInput = false)),
    )
  }

  @Test
  fun `blocked while the observation stream is down`() {
    assertEquals(
      DeviceControlBlockReason.ObservationStreamDisconnected,
      blockedReason(inputs(observationStreamConnected = false)),
    )
  }

  @Test
  fun `blocked before any frame has been applied`() {
    assertEquals(DeviceControlBlockReason.NoFrame, blockedReason(inputs(screenshot = null)))
    assertEquals(DeviceControlBlockReason.NoFrame, blockedReason(inputs(hierarchy = null)))
  }

  @Test
  fun `blocked while a source still belongs to a different device`() {
    // Device just switched: the previous device's screenshot or hierarchy still renders.
    assertEquals(
      DeviceControlBlockReason.DeviceMismatch,
      blockedReason(inputs(selectedDeviceId = "emulator-5556")),
    )
    assertEquals(
      DeviceControlBlockReason.DeviceMismatch,
      blockedReason(
        inputs(
          hierarchy =
            HierarchyFrameFacts(
              deviceId = "emulator-5556",
              sequence = 11L,
              captureSequence = 7L,
              receivedAtMs = 9_950L,
              hierarchy = hierarchyOf(1080, 2340),
              rootWidth = 1080,
              rootHeight = 2340,
            )
        )
      ),
    )
  }

  // ---- The two cases dimensions cannot detect (the reason for #3348) --------

  @Test
  fun `an equal-aspect resolution change cannot produce a mis-scaled tap`() {
    // The reviewer's P1, reproduced at the timing it ACTUALLY happens at. The device drops
    // 1080x2340 -> 720x1560. The new screenshot arrives 200 ms after the hierarchy the client is
    // still rendering — well inside any plausible "same device state" time window — and the two
    // resolutions share an aspect ratio exactly, so neither an elapsed-time check nor a dimension
    // comparison can separate them. Mapping a center click through the stale hierarchy's absolute
    // bounds would send (540,1170) instead of (360,780).
    //
    // Shared capture identity separates them at any delta: the daemon stamped the new screenshot
    // with the id of the hierarchy that produced 720x1560, and the client still holds the previous
    // capture.
    val decision =
      DeviceControlPolicy.evaluate(
        inputs(
          screenshot =
            ScreenshotFrameFacts(
              deviceId = device,
              sequence = 30L,
              captureSequence = 8L, // the capture that reported 720x1560
              receivedAtMs = 9_900L,
              width = 720,
              height = 1560,
              data = null,
              rotation = 0,
            ),
          hierarchy =
            HierarchyFrameFacts(
              deviceId = device,
              sequence = 11L,
              captureSequence = 7L, // still the previous capture, only 200 ms older
              receivedAtMs = 9_700L,
              hierarchy = hierarchyOf(1080, 2340),
              rootWidth = 1080,
              rootHeight = 2340,
              rotation = 0,
            ),
        ),
        now,
      )
    assertNull(decision.snapshotOrNull)
    assertEquals(
      DeviceControlBlockReason.UnpairedHierarchy,
      (decision as DeviceControlDecision.Blocked).reason,
    )
  }

  @Test
  fun `an unpaired hierarchy blocks control even when it is newer than the screenshot`() {
    // Direction-independent: the hierarchy can also run ahead of the screenshot (the tree updates
    // on an accessibility event while the next frame is still encoding). Either way the two do not
    // describe one capture, so nothing may be mapped through them.
    assertEquals(
      DeviceControlBlockReason.UnpairedHierarchy,
      blockedReason(
        inputs(
          hierarchy =
            HierarchyFrameFacts(
              deviceId = device,
              sequence = 12L,
              captureSequence = 9L,
              receivedAtMs = 9_990L,
              hierarchy = hierarchyOf(720, 1560),
              rootWidth = 720,
              rootHeight = 1560,
              rotation = 0,
            )
        )
      ),
    )
  }

  @Test
  fun `same-device rotation mismatch blocks a tap while hierarchy debounce is pending`() {
    // A screenshot captured after portrait -> landscape can retain the same device id, aspect
    // ratio, and request-bound capture identity as the hierarchy currently on screen. Rotation is
    // the remaining capture-time signal that tells us those sources cannot be mapped together.
    assertEquals(
      DeviceControlBlockReason.RotationMismatch,
      blockedReason(
        inputs(
          screenshot =
            ScreenshotFrameFacts(
              deviceId = device,
              sequence = 12L,
              captureSequence = 7L,
              receivedAtMs = 9_990L,
              width = 2340,
              height = 1080,
              data = null,
              rotation = 1,
            ),
          hierarchy =
            HierarchyFrameFacts(
              deviceId = device,
              sequence = 11L,
              captureSequence = 7L,
              receivedAtMs = 9_950L,
              hierarchy = hierarchyOf(1080, 2340),
              rootWidth = 1080,
              rootHeight = 2340,
              rotation = 0,
            ),
        )
      ),
    )
  }

  @Test
  fun `unknown rotation fails closed instead of pairing two malformed frames`() {
    assertEquals(
      DeviceControlBlockReason.RotationMismatch,
      blockedReason(
        inputs(
          screenshot =
            ScreenshotFrameFacts(
              deviceId = device,
              sequence = 12L,
              captureSequence = 7L,
              receivedAtMs = 9_990L,
              width = 1080,
              height = 2340,
              data = null,
              rotation = 4,
            ),
          hierarchy =
            HierarchyFrameFacts(
              deviceId = device,
              sequence = 11L,
              captureSequence = 7L,
              receivedAtMs = 9_950L,
              hierarchy = hierarchyOf(1080, 2340),
              rootWidth = 1080,
              rootHeight = 2340,
              rotation = 4,
            ),
        )
      ),
    )
  }

  @Test
  fun `matching device rotation keeps iOS native portrait pixels controllable in landscape`() {
    // iOS screenshot pixels remain native portrait-oriented while the device and hierarchy are
    // landscape. The policy compares device rotation, not pixel orientation, so the renderer may
    // keep its existing screenshot-rotation detection without disabling a valid frame.
    assertNotNull(
      DeviceControlPolicy.evaluate(
          inputs(
            screenshot =
              ScreenshotFrameFacts(
                deviceId = device,
                sequence = 12L,
                captureSequence = 7L,
                receivedAtMs = 9_990L,
                width = 1170,
                height = 2532,
                data = null,
                rotation = 1,
              ),
            hierarchy =
              HierarchyFrameFacts(
                deviceId = device,
                sequence = 11L,
                captureSequence = 7L,
                receivedAtMs = 9_950L,
                hierarchy = hierarchyOf(2532, 1170),
                rootWidth = 2532,
                rootHeight = 1170,
                rotation = 1,
              ),
          ),
          now,
        )
        .snapshotOrNull
    )
  }

  @Test
  fun `a screenshot whose pixels outran the hierarchy carries no identity and cannot mis-scale`() {
    // The daemon refuses to stamp a capture id on a frame whose real pixels do not match the
    // geometry its capture client claimed — the resolution-change window where fresh 720x1560
    // pixels are pushed before the hierarchy that describes them. The client must then refuse to
    // build a snapshot at all, rather than mapping the new pixels through the stale 1080x2340
    // bounds. The two share an aspect ratio, so no geometry check downstream could catch it.
    val decision =
      DeviceControlPolicy.evaluate(
        inputs(
          screenshot =
            ScreenshotFrameFacts(
              deviceId = device,
              sequence = 30L,
              captureSequence = null, // daemon could not prove the pairing
              receivedAtMs = 9_900L,
              width = 720,
              height = 1560,
              data = null,
            )
        ),
        now,
      )
    assertNull(decision.snapshotOrNull, "no snapshot means no mapping and no tap")
    assertEquals(
      DeviceControlBlockReason.CaptureIdentityUnavailable,
      (decision as DeviceControlDecision.Blocked).reason,
    )
  }

  @Test
  fun `control fails closed against a daemon that does not stamp capture identity`() {
    // Without the shared id there is no way to prove the two messages describe one capture, so
    // control is unavailable rather than guessing from time or dimensions.
    assertEquals(
      DeviceControlBlockReason.CaptureIdentityUnavailable,
      blockedReason(
        inputs(
          screenshot =
            ScreenshotFrameFacts(
              deviceId = device,
              sequence = 10L,
              captureSequence = null,
              receivedAtMs = 9_900L,
              width = 1080,
              height = 2340,
              data = null,
            )
        )
      ),
    )
  }

  @Test
  fun `a stalled live frame with unchanged geometry disables control`() {
    // The reviewer's other P1: the relay stalls in a blocking read while keeping its socket, its
    // Streaming state and its last bitmap. Dimensions never change, so a geometry gate stays
    // satisfied while the user clicks frozen content. Recency, not dimensions, retires it.
    val stalled =
      LiveFrameFacts(
        deviceId = device,
        sequence = 900L,
        receivedAtMs = now - DeviceControlPolicy.LIVE_FRAME_MAX_AGE_MS - 1,
        width = 1080,
        height = 2340,
        rotation = 0,
      )
    assertEquals(DeviceControlBlockReason.StaleFrame, blockedReason(inputs(liveFrame = stalled)))
  }

  @Test
  fun `a live frame that is still advancing keeps control available`() {
    val live =
      LiveFrameFacts(
        deviceId = device,
        sequence = 901L,
        receivedAtMs = now - 50L,
        width = 1080,
        height = 2340,
        rotation = 0,
      )
    val snapshot =
      assertNotNull(DeviceControlPolicy.evaluate(inputs(liveFrame = live), now).snapshotOrNull)
    assertEquals(DeviceFrameSource.LiveVideo, snapshot.source)
    assertEquals(901L, snapshot.liveFrameSequence, "the mirror's provenance is carried separately")
    // Ordering comes from the OBSERVATION counter alone: the mirror's counter is a different
    // domain, and folding it in would make the sequence fall back when the mirror clears.
    assertEquals(11L, snapshot.sequence)
  }

  @Test
  fun `a live frame without rotation provenance fails closed`() {
    val unproven =
      LiveFrameFacts(
        deviceId = device,
        sequence = 905L,
        receivedAtMs = now - 50L,
        width = 1080,
        height = 2340,
      )

    assertEquals(
      DeviceControlBlockReason.RotationMismatch,
      blockedReason(inputs(liveFrame = unproven)),
    )
  }

  @Test
  fun `a 180 degree live rotation blocks even when dimensions still match`() {
    // Rotation 0 -> 2 preserves 1080x2340, so the exact live-frame geometry check alone would
    // otherwise map the upside-down new pixels through the old hierarchy bounds.
    val upsideDown =
      LiveFrameFacts(
        deviceId = device,
        sequence = 906L,
        receivedAtMs = now - 50L,
        width = 1080,
        height = 2340,
        rotation = 2,
      )

    assertEquals(
      DeviceControlBlockReason.RotationMismatch,
      blockedReason(inputs(liveFrame = upsideDown)),
    )
  }

  @Test
  fun `a screenshot that stopped arriving retires control even on a connected stream`() {
    val stale =
      ScreenshotFrameFacts(
        deviceId = device,
        sequence = 10L,
        captureSequence = 7L,
        receivedAtMs = now - DeviceControlPolicy.SCREENSHOT_MAX_AGE_MS - 1,
        width = 1080,
        height = 2340,
        data = null,
        rotation = 0,
      )
    assertEquals(DeviceControlBlockReason.StaleFrame, blockedReason(inputs(screenshot = stale)))
  }

  // ---- Geometry cross-check: LEGACY aspect-only fallback --------------------
  // These pin the behavior for frames that declare no coordinate space (a pre-#4548 runner). The
  // px-mode exact checks are in the canonical-pixels section at the bottom of this file.

  @Test
  fun `legacy geometry is consistent up to rotation and scale for a polled screenshot`() {
    // The mixed-unit shape canonical pixels replaced: screenshot in device pixels, hierarchy in
    // logical points at 3x, rotated 90 degrees. Absolute dimensions are simply not comparable
    // here, so the aspect-only tolerance is all this path has — and it must NOT disable control.
    assert(
      DeviceControlPolicy.isGeometryConsistent(
        frameWidth = 2340,
        frameHeight = 1080,
        deviceWidth = 360,
        deviceHeight = 780,
      )
    )
  }

  @Test
  fun `legacy geometry is inconsistent when aspect ratios disagree beyond rotation`() {
    assert(
      !DeviceControlPolicy.isGeometryConsistent(
        frameWidth = 1920,
        frameHeight = 1080,
        deviceWidth = 1024,
        deviceHeight = 768,
      )
    )
  }

  @Test
  fun `a scaled live frame is blocked rather than mapped through mismatched bounds`() {
    // A live mirror frame carries no capture identity, so nothing pairs it with the observation
    // state. A fresh 720x1560 frame against 1080x2340 mapping bounds shares an aspect ratio
    // exactly, so an aspect check accepts it — and a center click is then sent as (540,1170)
    // instead of (360,780). Only an exact dimension match can exclude a scale change.
    val scaled =
      LiveFrameFacts(
        deviceId = device,
        sequence = 903L,
        receivedAtMs = now - 50L,
        width = 720,
        height = 1560,
        rotation = 0,
      )
    assertEquals(
      DeviceControlBlockReason.LiveFrameGeometryUnverifiable,
      blockedReason(inputs(liveFrame = scaled)),
    )
  }

  @Test
  fun `a legacy live frame in logical points against pixel bounds is blocked, not accepted`() {
    // The LEGACY iOS shape (no declared coordinate space): hierarchy bounds in points, mirror
    // pixels at 3x. An exact match is impossible here, so control is unavailable while mirroring
    // rather than acting on an unverifiable pair. Under `"px"` the same mirror now matches — see
    // `an iOS live mirror frame becomes verifiable once the hierarchy is published in pixels`.
    val points =
      LiveFrameFacts(
        deviceId = device,
        sequence = 904L,
        receivedAtMs = now - 50L,
        width = 360,
        height = 780,
        rotation = 0,
      )
    assertEquals(
      DeviceControlBlockReason.LiveFrameGeometryUnverifiable,
      blockedReason(inputs(liveFrame = points)),
    )
  }

  @Test
  fun `a live frame is held to the same orientation as the mapping bounds`() {
    // A live video frame is always display-oriented, so an orientation difference means the mirror
    // and the mapping bounds are out of sync. This is the cross-check provenance cannot supply for
    // the live path, which carries no daemon timestamp.
    val rotatedMirror =
      LiveFrameFacts(
        deviceId = device,
        sequence = 902L,
        receivedAtMs = now - 50L,
        width = 2340,
        height = 1080,
        rotation = 0,
      )
    assertEquals(
      DeviceControlBlockReason.LiveFrameGeometryUnverifiable,
      blockedReason(inputs(liveFrame = rotatedMirror)),
    )
  }

  @Test
  fun `a hierarchy root without bounds falls back to the observation screen size`() {
    // Common Android accessibility-service case: the root reports (0,0,0,0).
    val snapshot =
      assertNotNull(
        DeviceControlPolicy.evaluate(
            inputs(
              hierarchy =
                HierarchyFrameFacts(
                  deviceId = device,
                  sequence = 11L,
                  captureSequence = 7L,
                  receivedAtMs = 9_950L,
                  hierarchy = hierarchyOf(0, 0),
                  rootWidth = 0,
                  rootHeight = 0,
                  rotation = 0,
                )
            ),
            now,
          )
          .snapshotOrNull
      )
    assertEquals(1080, snapshot.deviceWidth)
    assertEquals(2340, snapshot.deviceHeight)
  }

  // ---- Canonical pixels: exact vs legacy geometry (issue #4550) -------------

  private fun screenshotFacts(width: Int, height: Int, coordinateSpace: CoordinateSpace?) =
    ScreenshotFrameFacts(
      deviceId = device,
      sequence = 10L,
      captureSequence = 7L,
      receivedAtMs = 9_900L,
      width = width,
      height = height,
      data = null,
      coordinateSpace = coordinateSpace,
      // Proven rotation so the #4502 gate passes and these tests isolate the COORDINATE-SPACE
      // behavior they were written for. Rotation has its own dedicated tests.
      rotation = 0,
    )

  private fun hierarchyFacts(width: Int, height: Int, coordinateSpace: CoordinateSpace?) =
    HierarchyFrameFacts(
      deviceId = device,
      sequence = 11L,
      captureSequence = 7L,
      receivedAtMs = 9_950L,
      hierarchy = hierarchyOf(width, height),
      rootWidth = width,
      rootHeight = height,
      coordinateSpace = coordinateSpace,
      rotation = 0,
    )

  /**
   * The whole point of the campaign, stated as one pair of assertions: the SAME geometry is
   * rejected under `"px"` and accepted under the legacy declaration-less frame. A 720x1560 frame
   * against 1080x2340 mapping bounds is an exact 2/3 uniform scale, so its aspect matches to the
   * bit; only an absolute comparison can see it. Under px both sides are physical pixels, so the
   * absolute comparison is meaningful and this pair cannot be anything but a mis-scale.
   */
  @Test
  fun `px mode rejects an equal-aspect scale that the legacy tolerance accepts`() {
    assertEquals(
      DeviceControlBlockReason.GeometryMismatch,
      blockedReason(
        inputs(
          screenshot = screenshotFacts(720, 1560, CoordinateSpace.Pixels),
          hierarchy = hierarchyFacts(1080, 2340, CoordinateSpace.Pixels),
        )
      ),
    )

    assertNotNull(
      DeviceControlPolicy.evaluate(
          inputs(
            screenshot = screenshotFacts(720, 1560, coordinateSpace = null),
            hierarchy = hierarchyFacts(1080, 2340, coordinateSpace = null),
          ),
          now,
        )
        .snapshotOrNull,
      "a legacy frame declares no unit, so absolute dimensions are not comparable and the " +
        "aspect-only fallback must still accept this pair",
    )
  }

  @Test
  fun `px mode accepts a frame whose pixels equal the mapping bounds`() {
    // iOS at 3x: 390x844 points published as 1170x2532 pixels, and the screenshot is the same
    // 1170x2532 PNG. Before canonical pixels these two could only be compared by aspect.
    val snapshot =
      assertNotNull(
        DeviceControlPolicy.evaluate(
            inputs(
              screenshot = screenshotFacts(1170, 2532, CoordinateSpace.Pixels),
              hierarchy = hierarchyFacts(1170, 2532, CoordinateSpace.Pixels),
            ),
            now,
          )
          .snapshotOrNull
      )
    assertEquals(1170, snapshot.deviceWidth)
    assertEquals(2532, snapshot.deviceHeight)
    // The agreed space is BOUND to the snapshot, not re-derived later: a snapshot outlives the
    // facts it was built from, and the unit its coordinates are in has to travel with it.
    assertEquals(CoordinateSpace.Pixels, snapshot.coordinateSpace)
  }

  @Test
  fun `a legacy snapshot binds a null space rather than inheriting one`() {
    val snapshot =
      assertNotNull(
        DeviceControlPolicy.evaluate(
            inputs(
              screenshot = screenshotFacts(1080, 2340, coordinateSpace = null),
              hierarchy = hierarchyFacts(1080, 2340, coordinateSpace = null),
            ),
            now,
          )
          .snapshotOrNull
      )
    assertNull(snapshot.coordinateSpace)
  }

  @Test
  fun `a snapshot built from disagreeing declarations binds the conservative legacy space`() {
    // The bound space must match the space the geometry was JUDGED in, or the snapshot would claim
    // a unit the policy never verified.
    val snapshot =
      assertNotNull(
        DeviceControlPolicy.evaluate(
            inputs(
              screenshot = screenshotFacts(1080, 2340, CoordinateSpace.Pixels),
              hierarchy = hierarchyFacts(1080, 2340, coordinateSpace = null),
            ),
            now,
          )
          .snapshotOrNull
      )
    assertNull(snapshot.coordinateSpace)
  }

  @Test
  fun `px mode keeps the rotation swap for a native-portrait screenshot`() {
    // The swap is a real property of the pixels, not a units artifact: a polled screenshot can
    // arrive in native portrait orientation against display-oriented bounds, and the renderer
    // rotates it. Exact comparison must not break landscape control.
    assertNotNull(
      DeviceControlPolicy.evaluate(
          inputs(
            screenshot = screenshotFacts(1170, 2532, CoordinateSpace.Pixels),
            hierarchy = hierarchyFacts(2532, 1170, CoordinateSpace.Pixels),
          ),
          now,
        )
        .snapshotOrNull
    )
  }

  @Test
  fun `px mode rejects a swap that is not the exact transpose`() {
    // The rotation allowance is exactly ONE alternative — the transpose. A near-transpose is a
    // different screen, and the legacy tolerance would have accepted it as "close enough".
    assertEquals(
      DeviceControlBlockReason.GeometryMismatch,
      blockedReason(
        inputs(
          screenshot = screenshotFacts(1170, 2532, CoordinateSpace.Pixels),
          hierarchy = hierarchyFacts(2534, 1172, CoordinateSpace.Pixels),
        )
      ),
    )
  }

  @Test
  fun `a declaration on only one of the two messages falls back to the legacy comparison`() {
    // All-or-nothing: one declared message paired with one undeclared message is exactly the
    // mixed-unit state the exact comparison must not be applied to. The daemon binds the two
    // together, so a disagreement means a transition is in flight — take the conservative path.
    assertNotNull(
      DeviceControlPolicy.evaluate(
          inputs(
            screenshot = screenshotFacts(720, 1560, CoordinateSpace.Pixels),
            hierarchy = hierarchyFacts(1080, 2340, coordinateSpace = null),
          ),
          now,
        )
        .snapshotOrNull,
      "screenshot declared px, hierarchy did not",
    )
    assertNotNull(
      DeviceControlPolicy.evaluate(
          inputs(
            screenshot = screenshotFacts(720, 1560, coordinateSpace = null),
            hierarchy = hierarchyFacts(1080, 2340, CoordinateSpace.Pixels),
          ),
          now,
        )
        .snapshotOrNull,
      "hierarchy declared px, screenshot did not",
    )
  }

  @Test
  fun `an iOS live mirror frame becomes verifiable once the hierarchy is published in pixels`() {
    // The carve-out this campaign retires. In point-space the mirror decoded 1170x2532 pixels
    // against 390x844 mapping bounds, so the exact live-frame check could never pass and iOS lost
    // control whenever a live mirror was displayed. Published in pixels, the same frame matches.
    val mirror =
      LiveFrameFacts(
        deviceId = device,
        sequence = 905L,
        receivedAtMs = now - 50L,
        width = 1170,
        height = 2532,
        rotation = 0,
      )
    val snapshot =
      assertNotNull(
        DeviceControlPolicy.evaluate(
            inputs(
              screenshot = screenshotFacts(1170, 2532, CoordinateSpace.Pixels),
              hierarchy = hierarchyFacts(1170, 2532, CoordinateSpace.Pixels),
              liveFrame = mirror,
            ),
            now,
          )
          .snapshotOrNull
      )
    assertEquals(DeviceFrameSource.LiveVideo, snapshot.source)
  }

  @Test
  fun `an iOS exact-half pixel frame enables control`() {
    // 375x811 points at nativeScale 3.5 rounds to 1313x2839 on both the runner screenshot claim
    // and daemon-published hierarchy. Pixels mode requires this exact equality.
    assertNotNull(
      DeviceControlPolicy.evaluate(
          inputs(
            screenshot = screenshotFacts(1313, 2839, CoordinateSpace.Pixels),
            hierarchy = hierarchyFacts(1313, 2839, CoordinateSpace.Pixels),
          ),
          now,
        )
        .snapshotOrNull
    )
  }

  @Test
  fun `isGeometryConsistent compares exactly only when told the space is pixels`() {
    // The pure function, exercised directly on the one input that separates the two modes.
    assert(
      DeviceControlPolicy.isGeometryConsistent(
        frameWidth = 720,
        frameHeight = 1560,
        deviceWidth = 1080,
        deviceHeight = 2340,
        coordinateSpace = null,
      )
    )
    assert(
      !DeviceControlPolicy.isGeometryConsistent(
        frameWidth = 720,
        frameHeight = 1560,
        deviceWidth = 1080,
        deviceHeight = 2340,
        coordinateSpace = CoordinateSpace.Pixels,
      )
    )
    // allowRotation still gates the transpose in exact mode.
    assert(
      !DeviceControlPolicy.isGeometryConsistent(
        frameWidth = 2340,
        frameHeight = 1080,
        deviceWidth = 1080,
        deviceHeight = 2340,
        allowRotation = false,
        coordinateSpace = CoordinateSpace.Pixels,
      )
    )
    // Neither mode can judge a frame with no reported device bounds; the renderer falls back to the
    // frame itself, so the two are consistent by construction.
    assert(
      DeviceControlPolicy.isGeometryConsistent(
        frameWidth = 1170,
        frameHeight = 2532,
        deviceWidth = 0,
        deviceHeight = 0,
        coordinateSpace = CoordinateSpace.Pixels,
      )
    )
  }

  @Test
  fun `fromWire distinguishes absent from declared-but-unrecognized`() {
    // Three states, not two. Collapsing an unknown declaration into the absent/legacy null would
    // both enable control through a path this client cannot justify and hide a transition from the
    // retained-frame guard.
    assertEquals(CoordinateSpace.Pixels, CoordinateSpace.fromWire("px"))
    assertNull(CoordinateSpace.fromWire(null), "absent stays absent — the legacy fallback")
    assertEquals(CoordinateSpace.Unrecognized("pt"), CoordinateSpace.fromWire("pt"))
    // The wire value is case-sensitive, so a differently-cased spelling is a DIFFERENT space, not
    // a sloppy "px" to be accepted.
    assertEquals(CoordinateSpace.Unrecognized("PX"), CoordinateSpace.fromWire("PX"))
  }

  @Test
  fun `a declared but unrecognized space blocks control instead of falling back to legacy`() {
    // Forward compatibility: a daemon newer than this client declares a space whose geometry AND
    // whose input-endpoint unit semantics are both unknown here. Degrading to the aspect-only
    // legacy branch would enable control and forward coordinates whose meaning the client cannot
    // justify. The geometry below is otherwise perfectly consistent, so only the space can block.
    val unknown = CoordinateSpace.Unrecognized("pt")
    assertEquals(
      DeviceControlBlockReason.UnsupportedCoordinateSpace,
      blockedReason(
        inputs(
          screenshot = screenshotFacts(1080, 2340, unknown),
          hierarchy = hierarchyFacts(1080, 2340, unknown),
        )
      ),
    )
    // Either message alone is enough to block — there is no "mostly readable" frame.
    assertEquals(
      DeviceControlBlockReason.UnsupportedCoordinateSpace,
      blockedReason(
        inputs(
          screenshot = screenshotFacts(1080, 2340, unknown),
          hierarchy = hierarchyFacts(1080, 2340, coordinateSpace = null),
        )
      ),
      "screenshot declared an unknown space",
    )
    assertEquals(
      DeviceControlBlockReason.UnsupportedCoordinateSpace,
      blockedReason(
        inputs(
          screenshot = screenshotFacts(1080, 2340, CoordinateSpace.Pixels),
          hierarchy = hierarchyFacts(1080, 2340, unknown),
        )
      ),
      "hierarchy declared an unknown space",
    )
  }

  @Test
  fun `an absent declaration still takes the legacy path, unlike an unrecognized one`() {
    // The contrast that makes the distinction meaningful: the SAME geometry that blocks under an
    // unknown declaration is available under no declaration at all.
    assertNotNull(
      DeviceControlPolicy.evaluate(
          inputs(
            screenshot = screenshotFacts(1080, 2340, coordinateSpace = null),
            hierarchy = hierarchyFacts(1080, 2340, coordinateSpace = null),
          ),
          now,
        )
        .snapshotOrNull
    )
  }

  @Test
  fun `snapshots with identical provenance but different spaces are not equal`() {
    // Equality is the provenance contract, and the coordinate space is part of it: the two frames
    // below carry coordinates that mean different physical locations, so equality-based state must
    // not conflate them.
    fun snapshotIn(space: CoordinateSpace?) =
      assertNotNull(
        DeviceControlPolicy.evaluate(
            inputs(
              screenshot = screenshotFacts(1080, 2340, space),
              hierarchy = hierarchyFacts(1080, 2340, space),
            ),
            now,
          )
          .snapshotOrNull
      )

    val legacy = snapshotIn(null)
    val pixels = snapshotIn(CoordinateSpace.Pixels)

    assertEquals(legacy.captureSequence, pixels.captureSequence, "provenance is identical")
    assertEquals(legacy.sequence, pixels.sequence)
    assertNotEquals(legacy, pixels, "but the coordinate space makes them different snapshots")
    assertNotEquals(legacy.hashCode(), pixels.hashCode())
    assertEquals(legacy, snapshotIn(null), "and equality still holds within one space")
  }
}
