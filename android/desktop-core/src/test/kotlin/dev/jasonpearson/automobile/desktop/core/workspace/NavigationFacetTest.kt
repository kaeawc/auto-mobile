package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.NavigationGraphStreamUpdate
import dev.jasonpearson.automobile.desktop.core.datasource.DefaultDataSourceFactory
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationGraph
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.AutoMobileGraphProvider
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenNode
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class NavigationFacetTest {

  /** In-memory graph so nothing the facet touches reaches a real socket. */
  private fun testGraph(): AutoMobileGraphProvider {
    val client = FakeAutoMobileClient()
    return object : AutoMobileGraphProvider {
      override val autoMobileClient = client
      override val settingsProvider = FakeSettingsProvider()
      override val dataSourceFactory = DefaultDataSourceFactory(client)
    }
  }

  private fun column(deviceId: String = "dev-1") =
    DeviceColumn(deviceId = deviceId, name = "Pixel", platform = Platform.Android)

  private fun screen(name: String) =
    ScreenNode(
      id = name.lowercase(),
      name = name,
      type = "Activity",
      packageName = "com.example.app",
      transitionCount = 0,
      discoveredAt = 0L,
    )

  /** A [NavigationDataSource] that returns a fixed result and counts invocations. */
  private class StubNavigationDataSource(private val result: Result<NavigationGraph>) :
    NavigationDataSource {
    val callCount = AtomicInteger(0)

    override suspend fun getNavigationGraph(): Result<NavigationGraph> {
      callCount.incrementAndGet()
      return result
    }
  }

  private fun navUpdate(appId: String?) =
    NavigationGraphStreamUpdate(
      timestamp = 1L,
      appId = appId,
      nodes = emptyList(),
      edges = emptyList(),
      currentScreen = null,
    )

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
                column = column(),
                observationStreamFactory = { fake },
                navigationDataSourceProvider = {
                  StubNavigationDataSource(
                    Result.Success(NavigationGraph(emptyList(), emptyList()))
                  )
                },
              )
            }
          }
        }
      }
      waitForIdle()

      assertEquals(1, fake.connectCallCount)
      assertEquals("dev-1", fake.lastConnectedDeviceId)
      assertTrue(
        "expected requestNavigationGraph to be issued on connect",
        fake.navigationRequestCount >= 1,
      )

      runOnIdle { visible.value = false }
      waitForIdle()
      assertTrue(
        "expected the stream to be disposed on removal",
        fake.disconnectCallCount >= 1,
      )
    }

  @Test
  fun `does not pull the app graph until a foreground app is resolved`() = runComposeUiTest {
    val fake = FakeObservationStream()
    val source =
      StubNavigationDataSource(Result.Success(NavigationGraph(listOf(screen("Home")), emptyList())))
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationFacet(
            column = column(),
            observationStreamFactory = { fake },
            navigationDataSourceProvider = { source },
          )
        }
      }
    }
    waitForIdle()

    // No stream update has arrived, so no foreground app is known and the app-scoped pull that
    // would otherwise show the wrong app's graph must not fire.
    assertEquals(0, source.callCount.get())

    fake.emitNavigation(navUpdate("com.example.app"))
    waitUntil(timeoutMillis = 5_000) { source.callCount.get() >= 1 }
    assertTrue(source.callCount.get() >= 1)
  }

  @Test
  fun `renders the app graph pulled from the data source once the foreground app resolves`() =
    runComposeUiTest {
      val fake = FakeObservationStream()
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            NavigationFacet(
              column = column(),
              observationStreamFactory = { fake },
              navigationDataSourceProvider = {
                StubNavigationDataSource(
                  Result.Success(NavigationGraph(listOf(screen("Home")), emptyList()))
                )
              },
            )
          }
        }
      }
      waitForIdle()
      fake.emitNavigation(navUpdate("com.example.app"))

      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Home").fetchSemanticsNodes().isNotEmpty()
      }
      onAllNodesWithText("Home").fetchSemanticsNodes().isNotEmpty()
    }

  @Test
  fun `two same-app panes render the same shared app graph`() = runComposeUiTest {
    val shared = NavigationGraph(listOf(screen("Home")), emptyList())
    val streamA = FakeObservationStream()
    val streamB = FakeObservationStream()
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationFacet(
            column = column("dev-1"),
            observationStreamFactory = { streamA },
            navigationDataSourceProvider = { StubNavigationDataSource(Result.Success(shared)) },
          )
          NavigationFacet(
            column = column("dev-2"),
            observationStreamFactory = { streamB },
            navigationDataSourceProvider = { StubNavigationDataSource(Result.Success(shared)) },
          )
        }
      }
    }
    waitForIdle()
    streamA.emitNavigation(navUpdate("com.example.app"))
    streamB.emitNavigation(navUpdate("com.example.app"))

    // Both panes resolve the same app and pull the same app-keyed graph, so the shared node
    // renders in both.
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Home").fetchSemanticsNodes().size >= 2
    }
    assertTrue(
      "both same-app panes should render the shared graph's Home node",
      onAllNodesWithText("Home").fetchSemanticsNodes().size >= 2,
    )
  }

  @Test
  fun `shows the empty state when the resolved app has no recorded graph`() = runComposeUiTest {
    val fake = FakeObservationStream()
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationFacet(
            column = column(),
            observationStreamFactory = { fake },
            navigationDataSourceProvider = {
              StubNavigationDataSource(Result.Success(NavigationGraph(emptyList(), emptyList())))
            },
          )
        }
      }
    }
    waitForIdle()
    fake.emitNavigation(navUpdate("com.example.app"))

    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("No navigation graph recorded", substring = true)
        .fetchSemanticsNodes()
        .isNotEmpty()
    }
    onNodeWithText("No navigation graph recorded", substring = true).assertExists()
  }

  @Test
  fun `surfaces a retryable error when the app graph fails to load`() = runComposeUiTest {
    val fake = FakeObservationStream()
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationFacet(
            column = column(),
            observationStreamFactory = { fake },
            navigationDataSourceProvider = {
              StubNavigationDataSource(Result.Error(RuntimeException("daemon down"), "daemon down"))
            },
          )
        }
      }
    }
    waitForIdle()
    fake.emitNavigation(navUpdate("com.example.app"))

    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("daemon down", substring = true).fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("daemon down", substring = true).assertExists()
    onNodeWithContentDescription("Retry loading navigation graph").assertExists()
  }

  @Test
  fun `retry re-invokes the loader and renders the recovered graph`() = runComposeUiTest {
    val fake = FakeObservationStream()
    val attempts = AtomicInteger(0)
    val recovering =
      object : NavigationDataSource {
        override suspend fun getNavigationGraph(): Result<NavigationGraph> =
          if (attempts.getAndIncrement() == 0)
            Result.Error(RuntimeException("daemon down"), "daemon down")
          else Result.Success(NavigationGraph(listOf(screen("Home")), emptyList()))
      }
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationFacet(
            column = column(),
            observationStreamFactory = { fake },
            navigationDataSourceProvider = { recovering },
          )
        }
      }
    }
    waitForIdle()
    fake.emitNavigation(navUpdate("com.example.app"))
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("daemon down", substring = true).fetchSemanticsNodes().isNotEmpty()
    }

    onNodeWithContentDescription("Retry loading navigation graph").performClick()
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Home").fetchSemanticsNodes().isNotEmpty()
    }
    onAllNodesWithText("Home").fetchSemanticsNodes().isNotEmpty()
  }

  @Test
  fun `reconnects to a new device when the column device changes`() = runComposeUiTest {
    val streams = mutableMapOf<String, FakeObservationStream>()
    val deviceId = mutableStateOf("dev-1")
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationFacet(
            column = column(deviceId.value),
            observationStreamFactory = { id -> streams.getOrPut(id) { FakeObservationStream() } },
            navigationDataSourceProvider = {
              StubNavigationDataSource(Result.Success(NavigationGraph(emptyList(), emptyList())))
            },
          )
        }
      }
    }
    waitForIdle()
    assertEquals(1, streams.getValue("dev-1").connectCallCount)

    runOnIdle { deviceId.value = "dev-2" }
    waitForIdle()

    assertTrue(streams.getValue("dev-1").disconnectCallCount >= 1)
    assertEquals(1, streams.getValue("dev-2").connectCallCount)
    assertEquals("dev-2", streams.getValue("dev-2").lastConnectedDeviceId)
  }
}
