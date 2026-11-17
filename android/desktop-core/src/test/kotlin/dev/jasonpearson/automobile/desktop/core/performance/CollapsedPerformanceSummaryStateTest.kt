package dev.jasonpearson.automobile.desktop.core.performance

import dev.jasonpearson.automobile.desktop.core.daemon.PerformanceStreamUpdate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CollapsedPerformanceSummaryStateTest {
  private fun update(fps: Float, memoryMb: Float) =
    PerformanceStreamUpdate(
      deviceId = "emulator-5554",
      timestamp = 1L,
      fps = fps,
      frameTimeMs = 16f,
      jankFrames = 0,
      droppedFrames = 0,
      memoryUsageMb = memoryMb,
      cpuUsagePercent = 10f,
      touchLatencyMs = null,
      timeToInteractiveMs = null,
      screenName = null,
      isResponsive = true,
      recompositionCount = null,
      recompositionRate = null,
    )

  @Test
  fun `starts empty`() {
    val state = CollapsedPerformanceSummaryState()

    assertNull(state.fps)
    assertNull(state.memoryMb)
  }

  @Test
  fun `apply keeps the latest frame rate and memory`() {
    val state = CollapsedPerformanceSummaryState()

    state.apply(update(fps = 58f, memoryMb = 120f))
    state.apply(update(fps = 42f, memoryMb = 140f))

    assertEquals(42f, state.fps)
    assertEquals(140f, state.memoryMb)
  }

  @Test
  fun `clear drops the values until the next update`() {
    val state = CollapsedPerformanceSummaryState()
    state.apply(update(fps = 60f, memoryMb = 100f))

    state.clear()

    assertNull(state.fps)
    assertNull(state.memoryMb)
  }
}
