package dev.jasonpearson.automobile.desktop.core.control

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

  // ---- Geometry cross-check (retained for the live path) --------------------

  @Test
  fun `geometry consistent up to rotation and scale for a polled screenshot`() {
    // iOS: screenshot in device pixels, hierarchy in logical points at 3x, rotated 90 degrees. The
    // renderer rotates the screenshot, so this must NOT disable control.
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
  fun `geometry inconsistent when aspect ratios disagree beyond rotation`() {
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
  fun `a live frame in logical points against pixel bounds is blocked, not accepted`() {
    // The iOS shape: hierarchy bounds in points, mirror pixels at 3x. An exact match is impossible
    // here, so control is unavailable while mirroring rather than acting on an unverifiable pair.
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
}
