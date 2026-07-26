package dev.jasonpearson.automobile.desktop.core.layout

import kotlin.test.assertEquals
import kotlin.test.assertNull
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
}
