package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.NavigationGraphStreamUpdate
import dev.jasonpearson.automobile.desktop.core.daemon.NavigationNodeData
import dev.jasonpearson.automobile.desktop.core.datasource.DefaultDataSourceFactory
import dev.jasonpearson.automobile.desktop.core.di.AutoMobileGraphProvider
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class NavigationFacetTest {

  /** In-memory graph so the dashboard's data-source load hits a fake client, never a socket. */
  private fun testGraph(): AutoMobileGraphProvider {
    val client = FakeAutoMobileClient()
    return object : AutoMobileGraphProvider {
      override val autoMobileClient = client
      override val settingsProvider = FakeSettingsProvider()
      override val dataSourceFactory = DefaultDataSourceFactory(client)
    }
  }

  @Test
  fun `connects the stream to the pane device, requests the graph, and disposes on removal`() =
    runComposeUiTest {
      val fake = FakeObservationStream()
      val visible = mutableStateOf(true)
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            if (visible.value) {
              NavigationFacet(
                column =
                  DeviceColumn(deviceId = "dev-1", name = "Pixel", platform = Platform.Android),
                observationStreamFactory = { fake },
              )
            }
          }
        }
      }
      waitForIdle()

      // (1) Connected exactly once, scoped to this pane's device.
      assertEquals(1, fake.connectCallCount)
      assertEquals("dev-1", fake.lastConnectedDeviceId)
      // (2) The dashboard requested the navigation graph on entry.
      assertTrue(
        "expected requestNavigationGraph to be issued",
        fake.navigationRequestCount >= 1,
      )

      // (4) Leaving composition disposes the stream (dispose -> disconnect).
      runOnIdle { visible.value = false }
      waitForIdle()
      assertTrue(
        "expected the stream to be disposed on removal",
        fake.disconnectCallCount >= 1,
      )
    }

  @Test
  fun `renders screen nodes emitted on the navigation stream`() = runComposeUiTest {
    val fake = FakeObservationStream()
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationFacet(
            column = DeviceColumn(deviceId = "dev-1", name = "Pixel", platform = Platform.Android),
            observationStreamFactory = { fake },
          )
        }
      }
    }
    waitForIdle()

    fake.emitNavigation(
      NavigationGraphStreamUpdate(
        timestamp = 1L,
        appId = "com.example.app",
        // Node labels render truncated to 12 chars on the canvas, so keep this short.
        nodes = listOf(NavigationNodeData(id = 1, screenName = "Login", visitCount = 2)),
        edges = emptyList(),
        currentScreen = "Login",
      )
    )
    waitForIdle()

    onAllNodesWithText("Login").onFirst().assertExists()
  }

  @Test
  fun `reconnects to a new device when the column device changes`() = runComposeUiTest {
    val streams = mutableMapOf<String, FakeObservationStream>()
    val deviceId = mutableStateOf("dev-1")
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationFacet(
            column =
              DeviceColumn(deviceId = deviceId.value, name = "Pixel", platform = Platform.Android),
            observationStreamFactory = { id -> streams.getOrPut(id) { FakeObservationStream() } },
          )
        }
      }
    }
    waitForIdle()
    assertEquals(1, streams.getValue("dev-1").connectCallCount)

    runOnIdle { deviceId.value = "dev-2" }
    waitForIdle()

    // Old stream disposed, new stream connected to the new device.
    assertTrue(streams.getValue("dev-1").disconnectCallCount >= 1)
    assertEquals(1, streams.getValue("dev-2").connectCallCount)
    assertEquals("dev-2", streams.getValue("dev-2").lastConnectedDeviceId)
  }
}
