package dev.jasonpearson.automobile.desktop.core.daemon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
  fun `requestNavigationGraph records the appId and count`() {
    val stream = FakeObservationStream()
    stream.requestNavigationGraph("com.example.app")
    assertEquals(1, stream.navigationRequestCount)
    assertEquals("com.example.app", stream.lastNavigationAppId)
  }
}
