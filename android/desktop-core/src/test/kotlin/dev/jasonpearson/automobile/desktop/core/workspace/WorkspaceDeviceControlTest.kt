package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class WorkspaceDeviceControlTest {

  @Test
  fun `default client reads the supplied session provider through registration and release`() {
    var sessionUuid: String? = null
    val client = createWorkspaceControlObservationClient(sessionUuidProvider = { sessionUuid })
    try {
      assertNull(client.authenticatedSessionUuid())
      sessionUuid = "registered-desktop"
      assertEquals(sessionUuid, client.authenticatedSessionUuid())
      sessionUuid = null
      assertNull(client.authenticatedSessionUuid())
    } finally {
      client.dispose()
    }
  }

  @Test
  fun `waits for registration and disposes on release and replacement`() = runComposeUiTest {
    val sessionUuid = mutableStateOf<String?>(null)
    val provider: () -> String? = { sessionUuid.value }
    val streams = mutableListOf<FakeObservationStream>()
    setContent {
      rememberWorkspaceDeviceControl(
        column = DeviceColumn(deviceId = "dev-1", name = "Pixel", platform = Platform.Android),
        clientProvider = { null },
        enabled = true,
        sessionUuidProvider = provider,
        streamFactory = { FakeObservationStream().also { streams.add(it) } },
      )
    }
    waitForIdle()
    assertTrue(streams.isEmpty())

    runOnIdle { sessionUuid.value = "registered-desktop" }
    waitForIdle()
    assertEquals(1, streams.size)
    assertEquals("dev-1", streams.single().lastConnectedDeviceId)
    assertEquals(1, streams.single().connectCallCount)

    runOnIdle { sessionUuid.value = "replacement-desktop" }
    waitForIdle()
    assertEquals(2, streams.size)
    assertTrue(streams.first().disconnectCallCount >= 1)
    assertEquals(1, streams.last().connectCallCount)

    runOnIdle { sessionUuid.value = null }
    waitForIdle()
    assertTrue(streams.last().disconnectCallCount >= 1)
    assertEquals(2, streams.size)

    runOnIdle { sessionUuid.value = "reregistered-desktop" }
    waitForIdle()
    assertEquals(3, streams.size)
    assertEquals(1, streams.last().connectCallCount)
  }

  @Test
  fun `omitted provider preserves legacy connection and disabled control disposes the stream`() =
    runComposeUiTest {
      val enabled = mutableStateOf(true)
      val fake = FakeObservationStream()
      var factoryCalls = 0
      setContent {
        rememberWorkspaceDeviceControl(
          column = DeviceColumn(deviceId = "dev-1", name = "Pixel", platform = Platform.Android),
          clientProvider = { null },
          enabled = enabled.value,
          streamFactory = {
            factoryCalls++
            fake
          },
        )
      }
      waitForIdle()
      assertEquals(1, factoryCalls)
      assertEquals(1, fake.connectCallCount)

      runOnIdle { enabled.value = false }
      waitForIdle()
      assertEquals(1, factoryCalls)
      assertTrue(fake.disconnectCallCount >= 1)
    }
}
