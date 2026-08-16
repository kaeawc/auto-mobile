package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.FakeTelemetryPushClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class LogsFacetTest {

  @Test
  fun `connects the telemetry client to the pane device and disposes when removed`() =
    runComposeUiTest {
      val fake = FakeTelemetryPushClient()
      val visible = mutableStateOf(true)
      setContent {
        MaterialTheme {
          if (visible.value) {
            LogsFacet(
              column =
                DeviceColumn(deviceId = "dev-1", name = "Pixel", platform = Platform.Android),
              telemetryClientFactory = { fake },
            )
          }
        }
      }
      waitForIdle()
      // Connected exactly once, to this pane's device.
      assertEquals("dev-1", fake.getLastDeviceId())
      assertEquals(1, fake.getConnectCallCount())

      // Leaving composition disposes the client (dispose → disconnect).
      runOnIdle { visible.value = false }
      waitForIdle()
      assertTrue(
        "expected the client to be disposed on removal",
        fake.getDisconnectCallCount() >= 1,
      )
    }
}
