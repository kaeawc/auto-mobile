package dev.jasonpearson.automobile.desktop.core

import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent
import dev.jasonpearson.automobile.desktop.core.mcp.McpConnectionType
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AutoMobileContentDeviceEventTest {
  @Test
  fun `handler disconnects layout and clears performance metrics for active device connection loss`() {
    val sink = FakeDeviceStreamEventSink()
    val handler =
      AutoMobileDeviceStreamEventHandler(
        activeDeviceId = { "emulator-5554" },
        sink = sink,
      )

    handler.handle(deviceConnectionLostEvent(deviceId = "emulator-5554"))

    assertEquals(1, sink.disconnectLayoutCalls)
    assertEquals(1, sink.clearPerformanceMetricsCalls)
  }

  @Test
  fun `handler ignores inactive device connection loss`() {
    val sink = FakeDeviceStreamEventSink()
    val handler =
      AutoMobileDeviceStreamEventHandler(
        activeDeviceId = { "emulator-5556" },
        sink = sink,
      )

    handler.handle(deviceConnectionLostEvent(deviceId = "emulator-5554"))

    assertEquals(0, sink.disconnectLayoutCalls)
    assertEquals(0, sink.clearPerformanceMetricsCalls)
  }

  @Test
  fun `handler ignores connection loss when no device is active`() {
    val sink = FakeDeviceStreamEventSink()
    val handler =
      AutoMobileDeviceStreamEventHandler(
        activeDeviceId = { null },
        sink = sink,
      )

    handler.handle(deviceConnectionLostEvent(deviceId = "emulator-5554"))

    assertEquals(0, sink.disconnectLayoutCalls)
    assertEquals(0, sink.clearPerformanceMetricsCalls)
  }

  @Test
  fun `device connection lost event matches active device`() {
    val event = deviceConnectionLostEvent(deviceId = "emulator-5554")

    assertEquals(event, activeDeviceConnectionLostEvent(event, activeDeviceId = "emulator-5554"))
  }

  @Test
  fun `device connection lost event ignores inactive device`() {
    val event = deviceConnectionLostEvent(deviceId = "emulator-5554")

    assertNull(activeDeviceConnectionLostEvent(event, activeDeviceId = "emulator-5556"))
  }

  @Test
  fun `device connection lost event ignores missing active device`() {
    val event = deviceConnectionLostEvent(deviceId = "emulator-5554")

    assertNull(activeDeviceConnectionLostEvent(event, activeDeviceId = null))
  }

  @Test
  fun `stream frame matches active device`() {
    assertTrue(
      isActiveDeviceStreamFrame(deviceId = "emulator-5554", activeDeviceId = "emulator-5554")
    )
  }

  @Test
  fun `stream frame ignores inactive device`() {
    assertFalse(
      isActiveDeviceStreamFrame(deviceId = "emulator-5554", activeDeviceId = "emulator-5556")
    )
  }

  @Test
  fun `stream frame ignores missing active device`() {
    assertFalse(isActiveDeviceStreamFrame(deviceId = "emulator-5554", activeDeviceId = null))
  }

  // ---- Device-control activation gate (issue #3347) -------------------------

  /** All conditions satisfied by default; each test flips exactly one to prove it gates. */
  private fun controlActive(
    enableDeviceControl: Boolean = true,
    isRealDeviceMode: Boolean = true,
    activeDeviceId: String? = "emulator-5554",
    connectionType: McpConnectionType? = McpConnectionType.UnixSocket,
    renderedDeviceId: String? = "emulator-5554",
    renderedHierarchyDeviceId: String? = "emulator-5554",
    isObservationStreamConnected: Boolean = true,
    isRenderedGeometryConsistent: Boolean = true,
  ) =
    isDeviceControlActive(
      enableDeviceControl = enableDeviceControl,
      isRealDeviceMode = isRealDeviceMode,
      activeDeviceId = activeDeviceId,
      connectionType = connectionType,
      renderedDeviceId = renderedDeviceId,
      renderedHierarchyDeviceId = renderedHierarchyDeviceId,
      isObservationStreamConnected = isObservationStreamConnected,
      isRenderedGeometryConsistent = isRenderedGeometryConsistent,
    )

  @Test
  fun `device control active when everything matches the selected device`() {
    assertTrue(controlActive())
  }

  @Test
  fun `device control inactive when not opted in`() {
    assertFalse(controlActive(enableDeviceControl = false))
  }

  @Test
  fun `device control inactive in fake mode`() {
    assertFalse(controlActive(isRealDeviceMode = false))
  }

  @Test
  fun `device control inactive with no explicitly selected device (Fake to Real clears selection)`() {
    // Switching Fake->Real keeps the socket and last frame but clears activeDeviceId; a tap then
    // would send deviceId=null and the daemon would pick a device the user never chose.
    assertFalse(
      controlActive(
        activeDeviceId = null,
        renderedDeviceId = null,
        renderedHierarchyDeviceId = null,
      )
    )
  }

  @Test
  fun `device control inactive on an input-incapable transport`() {
    assertFalse(controlActive(connectionType = McpConnectionType.StreamableHttp))
    assertFalse(controlActive(connectionType = null))
  }

  @Test
  fun `device control inactive while the rendered screenshot belongs to a different device`() {
    // Device just switched to B; the previous screenshot (A) still renders. A tap would be mapped
    // against A's screen yet sent to B — control must be inactive until B's frame arrives.
    assertFalse(controlActive(activeDeviceId = "emulator-5556"))
  }

  @Test
  fun `device control inactive while the hierarchy still belongs to a different device`() {
    // Screenshot for B has arrived but the hierarchy is still A's (streams update independently and
    // the hierarchy is debounced). A click would be hit-tested against A's bounds yet sent to B.
    assertFalse(
      controlActive(
        activeDeviceId = "emulator-5556",
        renderedDeviceId = "emulator-5556",
        renderedHierarchyDeviceId = "emulator-5554",
      )
    )
  }

  @Test
  fun `device control inactive once the rendered device identity is invalidated (stream disconnect)`() {
    // On observation-stream disconnect both ids are cleared; the frozen mirror must not be
    // tappable.
    assertFalse(controlActive(renderedDeviceId = null, renderedHierarchyDeviceId = null))
  }

  @Test
  fun `device control inactive while the observation stream is not connected`() {
    // Even if a stale frame's ids still match, a dead stream must keep control off.
    assertFalse(controlActive(isObservationStreamConnected = false))
  }

  @Test
  fun `device control inactive while screenshot and hierarchy geometry disagree`() {
    // e.g. a same-device rotation where the new screenshot and still-debounced old hierarchy
    // describe different orientations — a tap would map through the wrong scale.
    assertFalse(controlActive(isRenderedGeometryConsistent = false))
  }

  // ---- Rendered geometry consistency (issue #3347, part D) ------------------

  @Test
  fun `geometry consistent for matching portrait dimensions`() {
    assertTrue(
      isRenderedGeometryConsistent(
        screenshotWidth = 1080,
        screenshotHeight = 2340,
        hierarchyRootWidth = 1080,
        hierarchyRootHeight = 2340,
      )
    )
  }

  @Test
  fun `geometry consistent up to rotation and scale (iOS points vs pixels)`() {
    // Screenshot in device pixels, hierarchy in logical points at a 3x scale, rotated 90 degrees.
    assertTrue(
      isRenderedGeometryConsistent(
        screenshotWidth = 2340,
        screenshotHeight = 1080,
        hierarchyRootWidth = 360,
        hierarchyRootHeight = 780,
      )
    )
  }

  @Test
  fun `geometry inconsistent when aspect ratios disagree beyond rotation`() {
    // A 16:9 screenshot cannot be a rotation of a 4:3 hierarchy — a genuinely mismatched frame.
    assertFalse(
      isRenderedGeometryConsistent(
        screenshotWidth = 1920,
        screenshotHeight = 1080,
        hierarchyRootWidth = 1024,
        hierarchyRootHeight = 768,
      )
    )
  }

  @Test
  fun `live-frame geometry is strict about orientation`() {
    // Zero-bound Android path: the mapper uses the observation stream's screenWidth/screenHeight as
    // device bounds; the wiring feeds those effective bounds (never zero). A live video frame is
    // display-oriented, so a video whose orientation disagrees with those bounds is a stale frame
    // ->
    // control inactive.
    assertFalse(
      isRenderedGeometryConsistent(
        screenshotWidth = 2340, // live video: landscape
        screenshotHeight = 1080,
        hierarchyRootWidth = 1080, // effective device bounds (screenWidth/Height): portrait
        hierarchyRootHeight = 2340,
        allowRotation = false,
      )
    )
    // Same orientation -> consistent.
    assertTrue(
      isRenderedGeometryConsistent(
        screenshotWidth = 2340,
        screenshotHeight = 1080,
        hierarchyRootWidth = 2340,
        hierarchyRootHeight = 1080,
        allowRotation = false,
      )
    )
  }

  @Test
  fun `screenshot geometry tolerates the mappers rotation (iOS native orientation)`() {
    // A polled screenshot can arrive portrait-pixels while the device is landscape; the mapper
    // rotates it. That orientation difference must NOT disable control (allowRotation defaults
    // true).
    assertTrue(
      isRenderedGeometryConsistent(
        screenshotWidth = 1080, // screenshot: portrait pixels
        screenshotHeight = 2340,
        hierarchyRootWidth = 2340, // device bounds: landscape
        hierarchyRootHeight = 1080,
      )
    )
  }

  @Test
  fun `geometry inconsistent with no screenshot but consistent when hierarchy has no bounds`() {
    // No frame yet -> inconsistent (control stays off).
    assertFalse(
      isRenderedGeometryConsistent(
        screenshotWidth = 0,
        screenshotHeight = 0,
        hierarchyRootWidth = 1080,
        hierarchyRootHeight = 2340,
      )
    )
    // Hierarchy root without explicit bounds -> mapper falls back to screenshot dims -> consistent.
    assertTrue(
      isRenderedGeometryConsistent(
        screenshotWidth = 1080,
        screenshotHeight = 2340,
        hierarchyRootWidth = 0,
        hierarchyRootHeight = 0,
      )
    )
  }

  private fun deviceConnectionLostEvent(deviceId: String): DeviceStreamEvent.DeviceConnectionLost =
    DeviceStreamEvent.DeviceConnectionLost(
      deviceId = deviceId,
      timestamp = 1234,
      error = "device connection lost",
    )

  private class FakeDeviceStreamEventSink : AutoMobileDeviceStreamEventSink {
    var disconnectLayoutCalls = 0
      private set

    var clearPerformanceMetricsCalls = 0
      private set

    override fun disconnectLayout() {
      disconnectLayoutCalls++
    }

    override fun clearPerformanceMetrics() {
      clearPerformanceMetricsCalls++
    }
  }
}
