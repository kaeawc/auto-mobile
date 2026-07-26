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
        daemonTimestampMs = 5_000L,
        receivedAtMs = 9_900L,
        width = 1080,
        height = 2340,
      ),
    hierarchy: HierarchyFrameFacts? =
      HierarchyFrameFacts(
        deviceId = device,
        sequence = 11L,
        daemonTimestampMs = 5_050L,
        receivedAtMs = 9_950L,
        hierarchy = hierarchyOf(1080, 2340),
        rootWidth = 1080,
        rootHeight = 2340,
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
              daemonTimestampMs = 5_050L,
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
    // The reviewer's P1: the device drops 1080x2340 -> 720x1560. A new screenshot arrives; the
    // hierarchy has not caught up. The aspect ratios are IDENTICAL, so no dimension comparison can
    // tell them apart — but mapping a center click through the stale hierarchy's absolute bounds
    // would send (540,1170) instead of (360,780). Provenance catches it: the screenshot's daemon
    // timestamp advanced while the hierarchy's did not.
    val decision =
      DeviceControlPolicy.evaluate(
        inputs(
          screenshot =
            ScreenshotFrameFacts(
              deviceId = device,
              sequence = 30L,
              daemonTimestampMs = 9_000L,
              receivedAtMs = 9_900L,
              width = 720,
              height = 1560,
            ),
          hierarchy =
            HierarchyFrameFacts(
              deviceId = device,
              sequence = 11L,
              daemonTimestampMs = 5_050L, // stale: nearly 4s behind the screenshot
              receivedAtMs = 9_950L,
              hierarchy = hierarchyOf(1080, 2340),
              rootWidth = 1080,
              rootHeight = 2340,
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
  fun `an aspect-preserving resolution change is available again once the hierarchy is paired`() {
    // Same resolution change, but now the hierarchy update for the NEW resolution has arrived: the
    // pair is coherent, and the snapshot maps through the new bounds.
    val snapshot =
      DeviceControlPolicy.evaluate(
          inputs(
            screenshot =
              ScreenshotFrameFacts(
                deviceId = device,
                sequence = 30L,
                daemonTimestampMs = 9_000L,
                receivedAtMs = 9_900L,
                width = 720,
                height = 1560,
              ),
            hierarchy =
              HierarchyFrameFacts(
                deviceId = device,
                sequence = 31L,
                daemonTimestampMs = 9_060L,
                receivedAtMs = 9_950L,
                hierarchy = hierarchyOf(720, 1560),
                rootWidth = 720,
                rootHeight = 1560,
              ),
          ),
          now,
        )
        .snapshotOrNull
    assertNotNull(snapshot)
    assertEquals(720, snapshot.deviceWidth)
    assertEquals(1560, snapshot.deviceHeight)
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
      )
    val snapshot =
      assertNotNull(DeviceControlPolicy.evaluate(inputs(liveFrame = live), now).snapshotOrNull)
    assertEquals(DeviceFrameSource.LiveVideo, snapshot.source)
    assertEquals(901L, snapshot.liveFrameSequence)
    // The live frame is the newest source, so it orders the snapshot.
    assertEquals(901L, snapshot.sequence)
  }

  @Test
  fun `a screenshot that stopped arriving retires control even on a connected stream`() {
    val stale =
      ScreenshotFrameFacts(
        deviceId = device,
        sequence = 10L,
        daemonTimestampMs = 5_000L,
        receivedAtMs = now - DeviceControlPolicy.SCREENSHOT_MAX_AGE_MS - 1,
        width = 1080,
        height = 2340,
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
      )
    assertEquals(
      DeviceControlBlockReason.GeometryMismatch,
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
                  daemonTimestampMs = 5_050L,
                  receivedAtMs = 9_950L,
                  hierarchy = hierarchyOf(0, 0),
                  rootWidth = 0,
                  rootHeight = 0,
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
