package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class LayoutFacetTest {

  /** A factory that hands out a fresh [FakeObservationStream] per call and records each one. */
  private class RecordingStreamFactory : () -> ObservationStream {
    val created = mutableListOf<FakeObservationStream>()

    override fun invoke(): ObservationStream = FakeObservationStream().also { created += it }
  }

  @Test
  fun `connects the stream to the pane device and disposes when removed`() = runComposeUiTest {
    val fake = FakeObservationStream()
    val visible = mutableStateOf(true)
    setContent {
      MaterialTheme {
        if (visible.value) {
          LayoutFacet(
            column = DeviceColumn(deviceId = "dev-1", name = "Pixel", platform = Platform.Android),
            observationStreamFactory = { fake },
          )
        }
      }
    }
    waitForIdle()
    // Connected exactly once, to this pane's device.
    assertEquals("dev-1", fake.lastConnectedDeviceId)
    assertEquals(1, fake.connectCallCount)

    // Leaving composition disposes the stream (dispose → disconnect).
    runOnIdle { visible.value = false }
    waitForIdle()
    assertTrue("expected the stream to be disposed on removal", fake.disconnectCallCount >= 1)
  }

  @Test
  fun `re-keys to a new stream scoped to the new device when the pane device changes`() =
    runComposeUiTest {
      val factory = RecordingStreamFactory()
      val deviceId = mutableStateOf("dev-1")
      setContent {
        MaterialTheme {
          LayoutFacet(
            column =
              DeviceColumn(deviceId = deviceId.value, name = "Pixel", platform = Platform.Android),
            observationStreamFactory = factory,
          )
        }
      }
      waitForIdle()
      assertEquals(1, factory.created.size)
      assertEquals("dev-1", factory.created[0].lastConnectedDeviceId)
      assertEquals(1, factory.created[0].connectCallCount)

      // Changing the pane's device disposes the old stream and connects a fresh one to the new id.
      runOnIdle { deviceId.value = "dev-2" }
      waitForIdle()
      assertEquals(2, factory.created.size)
      assertTrue(
        "expected the previous device's stream to be disposed on re-key",
        factory.created[0].disconnectCallCount >= 1,
      )
      assertEquals("dev-2", factory.created[1].lastConnectedDeviceId)
      assertEquals(1, factory.created[1].connectCallCount)
    }

  @Test
  fun `two panes get two independent streams each scoped to its own device`() = runComposeUiTest {
    val factory = RecordingStreamFactory()
    setContent {
      MaterialTheme {
        Column {
          LayoutFacet(
            column = DeviceColumn(deviceId = "dev-1", name = "Pixel", platform = Platform.Android),
            observationStreamFactory = factory,
          )
          LayoutFacet(
            column = DeviceColumn(deviceId = "dev-2", name = "iPhone", platform = Platform.Ios),
            observationStreamFactory = factory,
          )
        }
      }
    }
    waitForIdle()
    // One distinct stream per pane, each connected exactly once to its own device.
    assertEquals(2, factory.created.size)
    assertEquals(setOf("dev-1", "dev-2"), factory.created.map { it.lastConnectedDeviceId }.toSet())
    assertTrue(factory.created.all { it.connectCallCount == 1 })
  }
}
