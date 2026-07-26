package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.core.isDeviceControlActive
import dev.jasonpearson.automobile.desktop.core.isRenderedGeometryConsistent
import dev.jasonpearson.automobile.desktop.core.mcp.McpConnectionType
import dev.jasonpearson.automobile.desktop.domain.ConnectionStatus
import dev.jasonpearson.automobile.desktop.domain.ElementBounds
import dev.jasonpearson.automobile.desktop.domain.UIElementInfo
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Test

/**
 * Coverage for the frame-generation + debounce-cancellation guards that keep device control
 * (issue #3347) from being re-enabled by a stale/superseded frame. Uses a virtual-time test
 * dispatcher for the debounce — no real timers or sockets.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LayoutInspectorStateFrameGenerationTest {

  private fun screenshot(
    state: LayoutInspectorState,
    deviceId: String,
    generation: Long,
  ) {
    state.updateScreenshot(
      data = byteArrayOf(1),
      width = 1080,
      height = 2340,
      timestamp = 1L,
      deviceId = deviceId,
      generation = generation,
    )
  }

  @Test
  fun `a screenshot from a superseded generation is dropped`() {
    val state = LayoutInspectorState()
    val stale = state.frameGeneration

    state.invalidateRenderedDeviceIdentity() // advances the generation

    screenshot(state, deviceId = "emulator-5554", generation = stale)
    assertNull(state.renderedDeviceId, "a late decode from before the invalidation must be dropped")

    // A current-generation update still applies.
    screenshot(state, deviceId = "emulator-5556", generation = state.frameGeneration)
    assertEquals("emulator-5556", state.renderedDeviceId)
  }

  @Test
  fun `invalidation cancels a pending debounced hierarchy so it cannot restore identity`() =
    runTest {
      val state = LayoutInspectorState(StandardTestDispatcher(testScheduler))
      val parsed = buildParsedHierarchy(LayoutInspectorMockData.mockHierarchy)

      state.applyHierarchyUpdate(parsed, emptySet(), deviceId = "emulator-5554")
      // Supersede it before the debounce fires (device change / stream disconnect).
      state.invalidateRenderedDeviceIdentity()
      advanceUntilIdle()

      assertNull(
        state.renderedHierarchyDeviceId,
        "the cancelled debounced job must not restore stale hierarchy identity",
      )
    }

  @Test
  fun `a debounced hierarchy applies after the debounce when it is not superseded`() = runTest {
    val state = LayoutInspectorState(StandardTestDispatcher(testScheduler))
    val parsed = buildParsedHierarchy(LayoutInspectorMockData.mockHierarchy)

    state.applyHierarchyUpdate(
      parsed,
      emptySet(),
      deviceId = "emulator-5554",
      generation = state.frameGeneration,
    )
    advanceUntilIdle()

    assertEquals("emulator-5554", state.renderedHierarchyDeviceId)
  }

  // A full-screen root so screenshot (1080x2340) and hierarchy geometry agree.
  private fun rootBounds(deviceWidth: Int = 1080, deviceHeight: Int = 2340) =
    UIElementInfo(
      id = "root",
      className = "android.widget.FrameLayout",
      resourceId = null,
      text = null,
      contentDescription = null,
      bounds = ElementBounds(0, 0, deviceWidth, deviceHeight),
      isClickable = false,
      isEnabled = true,
      isFocused = false,
      isSelected = false,
      isScrollable = false,
      isCheckable = false,
      isChecked = false,
      depth = 0,
      children = emptyList(),
    )

  private fun gateFor(state: LayoutInspectorState, device: String) =
    isDeviceControlActive(
      enableDeviceControl = true,
      isRealDeviceMode = true,
      activeDeviceId = device,
      connectionType = McpConnectionType.UnixSocket,
      renderedDeviceId = state.renderedDeviceId,
      renderedHierarchyDeviceId = state.renderedHierarchyDeviceId,
      isObservationStreamConnected = state.connectionStatus == ConnectionStatus.Connected,
      isRenderedGeometryConsistent =
        isRenderedGeometryConsistent(
          screenshotWidth = state.screenWidth,
          screenshotHeight = state.screenHeight,
          hierarchyRootWidth = state.hierarchy?.bounds?.width ?: 0,
          hierarchyRootHeight = state.hierarchy?.bounds?.height ?: 0,
        ),
    )

  @Test
  fun `reopening live layout for the same device stays inactive until fresh frames arrive`() {
    val state = LayoutInspectorState()
    val device = "emulator-5554"

    // A prior Live Layout session rendered a live frame for this device.
    state.updateScreenshot(
      byteArrayOf(1),
      1080,
      2340,
      1L,
      deviceId = device,
      generation = state.frameGeneration,
    )
    state.updateHierarchy(rootBounds(), deviceId = device)
    state.updateConnectionStatus(ConnectionStatus.Connected)
    assertTrue(gateFor(state, device), "control was active in the prior session")

    // Closing then reopening Live Layout runs the lifecycle reset (mark not-live + invalidate).
    state.updateConnectionStatus(ConnectionStatus.Disconnected)
    state.invalidateRenderedDeviceIdentity()
    assertFalse(gateFor(state, device), "reopen must start invalidated, not tap the frozen mirror")

    // Only genuinely fresh screenshot + hierarchy frames re-arm control.
    state.updateScreenshot(
      byteArrayOf(2),
      1080,
      2340,
      2L,
      deviceId = device,
      generation = state.frameGeneration,
    )
    state.updateHierarchy(rootBounds(), deviceId = device)
    state.updateConnectionStatus(ConnectionStatus.Connected)
    assertTrue(gateFor(state, device), "fresh frames re-arm control")
  }
}
