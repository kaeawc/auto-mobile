package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.FakeTelemetryPushClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class LogsFacetTest {

  @Test
  fun `default client reads the supplied session provider through registration and release`() {
    var sessionUuid: String? = null
    val client = createLogsTelemetryClient(sessionUuidProvider = { sessionUuid })
    try {
      assertNull(client.subscribeRequest().sessionUuid)
      sessionUuid = "registered-desktop"
      assertEquals(sessionUuid, client.subscribeRequest().sessionUuid)
      sessionUuid = null
      assertNull(client.subscribeRequest().sessionUuid)
    } finally {
      client.dispose()
    }
  }

  @Test
  fun `waits for registration and disposes on release before creating a fresh client`() =
    runComposeUiTest {
      val sessionUuid = mutableStateOf<String?>(null)
      val provider: () -> String? = { sessionUuid.value }
      val clients = mutableListOf<FakeTelemetryPushClient>()
      setContent {
        MaterialTheme {
          LogsFacet(
            column =
              DeviceColumn(
                deviceId = "dev-1",
                name = "Pixel",
                platform = Platform.Android,
                deviceSessionUuid = "uuid-1",
              ),
            sessionUuidProvider = provider,
            telemetryClientFactory = { FakeTelemetryPushClient().also { clients.add(it) } },
          )
        }
      }
      waitForIdle()
      assertTrue(clients.isEmpty())

      runOnIdle { sessionUuid.value = "registered-desktop" }
      waitForIdle()
      assertEquals(1, clients.size)
      assertEquals("dev-1", clients.single().getLastDeviceId())
      assertEquals("uuid-1", clients.single().getLastDeviceSessionUuid())
      assertEquals(1, clients.single().getConnectCallCount())

      runOnIdle { sessionUuid.value = null }
      waitForIdle()
      assertTrue(clients.single().getDisconnectCallCount() >= 1)
      assertEquals(1, clients.size)

      runOnIdle { sessionUuid.value = "replacement-desktop" }
      waitForIdle()
      assertEquals(2, clients.size)
      assertEquals(1, clients.last().getConnectCallCount())
    }

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
