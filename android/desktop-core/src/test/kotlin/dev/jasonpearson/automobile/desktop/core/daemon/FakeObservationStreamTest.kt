package dev.jasonpearson.automobile.desktop.core.daemon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FakeObservationStreamTest {

  @Test
  fun `connect records the device and count, dispose disconnects`() {
    val stream = FakeObservationStream()
    assertFalse(stream.isConnected())

    stream.connect("dev-1")
    assertTrue(stream.isConnected())
    assertEquals(1, stream.connectCallCount)
    assertEquals("dev-1", stream.lastConnectedDeviceId)

    stream.dispose()
    assertFalse(stream.isConnected())
    assertEquals(1, stream.disconnectCallCount)
  }

  @Test
  fun `requestNavigationGraph records the appId and count when connected`() {
    val stream = FakeObservationStream()
    stream.connect("dev-1")

    stream.requestNavigationGraph("com.example.app")
    assertEquals(1, stream.navigationRequestCount)
    assertEquals("com.example.app", stream.lastNavigationAppId)
  }

  @Test
  fun `requestNavigationGraph is a no-op while disconnected`() {
    // Mirrors the real ObservationStreamClient, which returns early unless connected. Without this
    // guard a disconnected test could get a false positive that a graph was requested.
    val stream = FakeObservationStream()
    assertFalse(stream.isConnected())

    stream.requestNavigationGraph("com.example.app")

    assertEquals(0, stream.navigationRequestCount)
    assertNull(stream.lastNavigationAppId)
  }

  @Test
  fun `resetLayoutReplayCache clears the replayed screenshot and hierarchy frames`() {
    // Mirrors the real client, which drops the buffered layout replay so a resubscribing collector
    // does not immediately receive the last pre-reset frame.
    val stream = FakeObservationStream()
    stream.connect("dev-1")

    stream.emitScreenshot(
      ScreenshotStreamUpdate(
        deviceId = "dev-1",
        timestamp = 1L,
        screenshotBase64 = "abc",
        screenWidth = 1080,
        screenHeight = 2340,
      )
    )
    stream.emitHierarchy(HierarchyStreamUpdate(deviceId = "dev-1", timestamp = 1L, data = null))

    assertTrue(stream.screenshotUpdates.replayCache.isNotEmpty())
    assertTrue(stream.hierarchyUpdates.replayCache.isNotEmpty())

    stream.resetLayoutReplayCache()

    assertTrue(stream.screenshotUpdates.replayCache.isEmpty())
    assertTrue(stream.hierarchyUpdates.replayCache.isEmpty())
  }
}
