package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.PerformanceStreamUpdate
import dev.jasonpearson.automobile.desktop.core.datasource.DefaultDataSourceFactory
import dev.jasonpearson.automobile.desktop.core.di.AutoMobileGraphProvider
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.platform.AppVersion
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.core.update.FakeUpdateController
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class PerformanceFacetTest {

  /**
   * A DI graph backed by a [FakeAutoMobileClient] so the dashboard's audit-history fallback
   * resolves to an empty run (no socket), keeping these tests deterministic. The live-metrics path
   * under test comes from the injected [FakeObservationStream], not this client.
   */
  private fun fakeGraph(): AutoMobileGraphProvider {
    val client = FakeAutoMobileClient()
    return object : AutoMobileGraphProvider {
      override val autoMobileClient = client
      override val settingsProvider = FakeSettingsProvider()
      override val dataSourceFactory = DefaultDataSourceFactory(client)
      override val updateController = FakeUpdateController()
      override val appVersionProvider = AppVersionProvider { AppVersion.Dev }
    }
  }

  private fun perfUpdate(deviceId: String?, fps: Float) =
    PerformanceStreamUpdate(
      deviceId = deviceId,
      timestamp = 1_000L,
      fps = fps,
      frameTimeMs = 16f,
      jankFrames = 0,
      droppedFrames = 0,
      memoryUsageMb = 100f,
      cpuUsagePercent = 10f,
      touchLatencyMs = null,
      timeToInteractiveMs = null,
      screenName = null,
      isResponsive = true,
      recompositionCount = null,
      recompositionRate = null,
    )

  @Test
  fun `connects the stream to the pane device and disposes when removed`() = runComposeUiTest {
    val fake = FakeObservationStream()
    val visible = mutableStateOf(true)
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides fakeGraph()) {
        MaterialTheme {
          if (visible.value) {
            PerformanceFacet(
              column =
                DeviceColumn(deviceId = "dev-1", name = "Pixel", platform = Platform.Android),
              observationStreamFactory = { fake },
            )
          }
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
  fun `reconnects to the new device when the pane device changes`() = runComposeUiTest {
    val fake = FakeObservationStream()
    val deviceId = mutableStateOf("dev-1")
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides fakeGraph()) {
        MaterialTheme {
          PerformanceFacet(
            column =
              DeviceColumn(deviceId = deviceId.value, name = "Pixel", platform = Platform.Android),
            observationStreamFactory = { fake },
          )
        }
      }
    }
    waitForIdle()
    assertEquals(1, fake.connectCallCount)

    runOnIdle { deviceId.value = "dev-2" }
    waitForIdle()
    // The old subscription is disposed and a new connect targets the new device.
    assertEquals("dev-2", fake.lastConnectedDeviceId)
    assertEquals(2, fake.connectCallCount)
    assertTrue(fake.disconnectCallCount >= 1)
  }

  @Test
  fun `reconnects the pane stream after a mid-session drop`() = runComposeUiTest {
    val fake = FakeObservationStream()
    // A gate the test releases to let the single reconnect attempt proceed with zero wall time.
    val backoff = CompletableDeferred<Unit>()
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides fakeGraph()) {
        MaterialTheme {
          PerformanceFacet(
            column = DeviceColumn(deviceId = "dev-1", name = "Pixel", platform = Platform.Android),
            observationStreamFactory = { fake },
            backoffDelay = { backoff.await() },
            socketAvailable = { true },
          )
        }
      }
    }
    waitForIdle()
    assertEquals(1, fake.connectCallCount)

    // A daemon restart / EOF surfaces as a Disconnected state; the facet must reconnect instead of
    // staying blank (Performance had no recovery path before).
    runOnIdle { fake.emitConnectionState(ConnectionState.Disconnected("Stream ended")) }
    waitForIdle()
    runOnIdle { backoff.complete(Unit) }
    waitForIdle()
    assertEquals("expected the perf facet to reconnect after a drop", 2, fake.connectCallCount)
  }

  @Test
  fun `renders a live metric from a stream update for this device`() = runComposeUiTest {
    val fake = FakeObservationStream()
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides fakeGraph()) {
        MaterialTheme {
          PerformanceFacet(
            column = DeviceColumn(deviceId = "dev-1", name = "Pixel", platform = Platform.Android),
            observationStreamFactory = { fake },
          )
        }
      }
    }
    waitForIdle()
    runOnIdle { fake.emitPerformance(perfUpdate(deviceId = "dev-1", fps = 30f)) }
    waitForIdle()
    onNodeWithText("Frame Rate").assertIsDisplayed()
  }

  @Test
  fun `ignores a stream update for another device`() = runComposeUiTest {
    val fake = FakeObservationStream()
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides fakeGraph()) {
        MaterialTheme {
          PerformanceFacet(
            column = DeviceColumn(deviceId = "dev-1", name = "Pixel", platform = Platform.Android),
            observationStreamFactory = { fake },
          )
        }
      }
    }
    waitForIdle()
    runOnIdle { fake.emitPerformance(perfUpdate(deviceId = "other", fps = 30f)) }
    waitForIdle()
    // Filtered out: no metric cards render, only the empty "waiting" state.
    onNodeWithText("Waiting for performance data...").assertIsDisplayed()
  }
}
