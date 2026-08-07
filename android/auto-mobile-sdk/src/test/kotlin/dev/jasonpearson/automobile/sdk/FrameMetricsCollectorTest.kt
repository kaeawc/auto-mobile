package dev.jasonpearson.automobile.sdk

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class FrameMetricsCollectorTest {

  @Test
  fun `buildSnapshotJson aggregates fps, jank, and average frame time`() {
    val window =
      listOf(
        FrameMetricsCollector.FrameSample(t = 0, durationMs = 10.0),
        FrameMetricsCollector.FrameSample(t = 0, durationMs = 20.0), // jank (> 16.7ms)
        FrameMetricsCollector.FrameSample(t = 0, durationMs = 30.0), // jank
      )

    val json = JSONObject(FrameMetricsCollector.buildSnapshotJson("com.example", window, 1000L))

    assertEquals("com.example", json.getString("applicationId"))
    assertEquals(3, json.getInt("totalFrames"))
    assertEquals(20.0, json.getDouble("frameTimeMs"), 0.001) // (10 + 20 + 30) / 3
    assertEquals(2, json.getInt("jankFrames")) // 20ms and 30ms exceed the 16.7ms threshold
    assertEquals(50.0, json.getDouble("fps"), 0.001) // 1000 / 20ms
  }

  @Test
  fun `buildSnapshotJson omits frame fields when no frames rendered`() {
    val json =
      JSONObject(FrameMetricsCollector.buildSnapshotJson("com.example", emptyList(), 1000L))

    assertEquals(0, json.getInt("totalFrames"))
    assertFalse(json.has("fps"))
    assertFalse(json.has("frameTimeMs"))
    assertFalse(json.has("jankFrames"))
  }
}
