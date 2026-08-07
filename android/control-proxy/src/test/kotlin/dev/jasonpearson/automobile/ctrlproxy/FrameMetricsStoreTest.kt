package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.FrameMetricsSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FrameMetricsStoreTest {

  @Test
  fun `getLatest is null before any snapshot`() {
    assertNull(FrameMetricsStore().getLatest())
  }

  @Test
  fun `getLatest returns the most recent snapshot`() {
    val store = FrameMetricsStore()
    store.updateSnapshot(
      FrameMetricsSnapshot(timestamp = 1L, applicationId = "com.a", fps = 60.0, totalFrames = 60)
    )
    store.updateSnapshot(
      FrameMetricsSnapshot(
        timestamp = 2L,
        applicationId = "com.a",
        fps = 45.0,
        frameTimeMs = 22.2,
        jankFrames = 4,
        totalFrames = 45,
      )
    )

    val latest = store.getLatest()
    assertEquals(2L, latest?.timestamp)
    assertEquals(45.0, latest?.fps)
    assertEquals(4, latest?.jankFrames)
  }
}
