package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamKey
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.FakeTelemetryMultiplexer
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationHubConfig
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationReconnectPolicy
import dev.jasonpearson.automobile.desktop.core.daemon.ScreenshotStreamUpdate
import dev.jasonpearson.automobile.desktop.core.daemon.SharedDaemonStreamHub
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assert.assertEquals
import org.junit.Test

/** Save Screenshot from a pane whose app has a [SharedDaemonStreamHub] (#17027). */
@OptIn(ExperimentalTestApi::class, ExperimentalCoroutinesApi::class)
internal class WorkspaceScreenshotHubUiTest {
  private val onePxPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

  @Test
  fun `Screenshot leases the pane's shared stream and saves a frame captured after the tap`() =
    runComposeUiTest {
      val key = DeviceStreamKey("a", "session-a")
      val streams = mutableListOf<FakeObservationStream>()
      val scope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher())
      val hub = hub(scope, streams)
      // A facet on the pane already holds the device's shared stream, with a frame from earlier.
      hub.observationStream(key).connect()
      val shared = streams.single()
      shared.emitScreenshot(ScreenshotStreamUpdate("a", 100L, "c3RhbGU=", 1, 1))
      var opened = 0
      var savedBytes: ByteArray? = null
      setContent {
        MaterialTheme {
          CompositionLocalProvider(LocalDaemonStreamHub provides hub) {
            WorkspaceShell(
              state =
                WorkspaceUiState.Content(
                  columns =
                    listOf(
                      DeviceColumn(
                        deviceId = "a",
                        name = "Pixel 8",
                        platform = Platform.Android,
                        deviceSessionUuid = "session-a",
                      ),
                    ),
                  focusedDeviceId = "a",
                ),
              onAction = {},
              options =
                WorkspaceShellOptions(
                  onOpenPicker = {},
                  observationStreamFactory = { FakeObservationStream().also { opened++ } },
                  screenshotSaver =
                    ScreenshotSaver { name, bytes ->
                      savedBytes = bytes
                      "/tmp/shots/$name.png"
                    },
                ),
            )
          }
        }
      }

      onNodeWithContentDescription("Screenshot Pixel 8").performClick()
      waitUntil(timeoutMillis = 5_000L) { shared.observationRequestCount == 1 }
      assertEquals(mapOf(key to 2), hub.observationSubscriptions.value)

      shared.emitScreenshot(ScreenshotStreamUpdate("a", 200L, onePxPng, 1, 1))
      waitUntil(timeoutMillis = 5_000L) { savedBytes != null }
      assertEquals(java.util.Base64.getDecoder().decode(onePxPng).toList(), savedBytes!!.toList())
      waitUntil(timeoutMillis = 5_000L) { hub.observationSubscriptions.value == mapOf(key to 1) }
      assertEquals(0, opened)
      assertEquals(1, streams.size)
      hub.close()
      scope.cancel()
    }

  private fun hub(scope: CoroutineScope, streams: MutableList<FakeObservationStream>) =
    SharedDaemonStreamHub(
      telemetry = FakeTelemetryMultiplexer(),
      scope = scope,
      observation =
        ObservationHubConfig(
          streamFactory = { FakeObservationStream().also { streams.add(it) } },
          reconnect = ObservationReconnectPolicy({ awaitCancellation() }, { true }),
        ),
    )
}
