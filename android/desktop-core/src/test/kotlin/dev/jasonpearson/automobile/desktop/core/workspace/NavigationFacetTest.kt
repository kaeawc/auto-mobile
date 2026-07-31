package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.NavigationGraphStreamUpdate
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
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
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.SharedFlow
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

  private fun navUpdate(appId: String?, currentScreen: String? = null) =
    NavigationGraphStreamUpdate(
      timestamp = 1L,
      appId = appId,
      nodes = emptyList(),
      edges = emptyList(),
      currentScreen = currentScreen,
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
  fun `shows the no-app guidance when a connected stream reports a null current app`() =
    runComposeUiTest {
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

      // Fresh daemon / onboarding: the stream is connected but reports no current app (appId null).
      // The facet must guide the user rather than hang on the indefinite Resolving spinner.
      fake.emitNavigation(navUpdate(appId = null))
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Open an app on this device", substring = true)
          .fetchSemanticsNodes()
          .isNotEmpty()
      }
      onNodeWithText("Open an app on this device", substring = true).assertExists()
      assertTrue(
        "null-app must not leave the facet stuck on Resolving",
        onAllNodesWithText("Resolving navigation graph", substring = true)
          .fetchSemanticsNodes()
          .isEmpty(),
      )
    }

  @Test
  fun `carries the current screen into the dashboard so Fog and auto-focus are enabled`() =
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

      // The nav update carries both the resolved app and its current screen. Under the
      // app-scoped-pull path the dashboard bypasses its own stream collector, so unless the facet
      // threads currentScreen through, the canvas's Fog toggle stays disabled.
      fake.emitNavigation(navUpdate(appId = "com.example.app", currentScreen = "Home"))
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithContentDescription("Fog focus available").fetchSemanticsNodes().isNotEmpty()
      }
      onNodeWithContentDescription("Fog focus available").assertExists()
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
  fun `surfaces a retryable connection error when the stream never connects and retry recreates it`() =
    runComposeUiTest {
      val created = mutableListOf<FakeObservationStream>()
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            NavigationFacet(
              column = column(),
              observationStreamFactory = {
                FakeObservationStream(failConnect = true).also { created.add(it) }
              },
              navigationDataSourceProvider = {
                StubNavigationDataSource(Result.Success(NavigationGraph(emptyList(), emptyList())))
              },
            )
          }
        }
      }

      // The socket never connects and the facet resolves the app id FROM the stream, so without
      // this path it would hang on "Resolving…" forever. Instead it must surface a retryable
      // connection error.
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Socket not found", substring = true).fetchSemanticsNodes().isNotEmpty()
      }
      onNodeWithText("Socket not found", substring = true).assertExists()
      assertTrue(
        "must not be stuck on the indefinite Resolving state",
        onAllNodesWithText("Resolving navigation graph", substring = true)
          .fetchSemanticsNodes()
          .isEmpty(),
      )
      onNodeWithContentDescription("Retry connecting to the AutoMobile daemon").assertExists()
      assertEquals(1, created.size)

      // Retry tears down and recreates the stream (re-attempting connect + appId resolution).
      onNodeWithContentDescription("Retry connecting to the AutoMobile daemon").performClick()
      waitUntil(timeoutMillis = 5_000) { created.size >= 2 }
      assertTrue("retry should recreate the observation stream", created.size >= 2)
      assertTrue(
        "recreated stream should have been connected",
        created.last().connectCallCount >= 1,
      )
    }

  @Test
  fun `surfaces the reconnect affordance when the stream drops after an app resolved`() =
    runComposeUiTest {
      val created = mutableListOf<FakeObservationStream>()
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            NavigationFacet(
              column = column(),
              observationStreamFactory = { FakeObservationStream().also { created.add(it) } },
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

      // App resolves and its graph renders.
      created.first().emitNavigation(navUpdate("com.example.app"))
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Home").fetchSemanticsNodes().isNotEmpty()
      }

      // Socket EOF *after* resolution: without post-resolution handling the facet would silently
      // retain a dead stream. It must instead expose the retryable reconnect affordance.
      runOnIdle {
        created.first().emitConnectionState(ConnectionState.Disconnected("Stream ended"))
      }
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Stream ended", substring = true).fetchSemanticsNodes().isNotEmpty()
      }
      onNodeWithText("Stream ended", substring = true).assertExists()
      onNodeWithContentDescription("Retry connecting to the AutoMobile daemon").assertExists()
      assertEquals(1, created.size)

      // Retry recreates the stream (reusing the streamAttempt mechanism).
      onNodeWithContentDescription("Retry connecting to the AutoMobile daemon").performClick()
      waitUntil(timeoutMillis = 5_000) { created.size >= 2 }
      assertTrue("retry should recreate the observation stream", created.size >= 2)
    }

  @Test
  fun `retry after an outage re-resolves the replacement app and never retains the pre-outage app`() =
    runComposeUiTest {
      val created = mutableListOf<FakeObservationStream>()
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            NavigationFacet(
              column = column(),
              observationStreamFactory = { FakeObservationStream().also { created.add(it) } },
              navigationDataSourceProvider = { appId ->
                // Distinct graph per app so a stale render is detectable by screen name.
                val label = if (appId == "com.example.b") "Beta" else "Alpha"
                StubNavigationDataSource(
                  Result.Success(NavigationGraph(listOf(screen(label)), emptyList()))
                )
              },
            )
          }
        }
      }
      waitForIdle()

      // Resolve app A; its graph renders.
      created.first().emitNavigation(navUpdate("com.example.a"))
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty()
      }

      // Stream drops mid-session (user then switches to app B during the outage).
      runOnIdle {
        created.first().emitConnectionState(ConnectionState.Disconnected("Stream ended"))
      }
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithContentDescription("Retry connecting to the AutoMobile daemon")
          .fetchSemanticsNodes()
          .isNotEmpty()
      }

      // Retry recreates the stream. The pre-outage app A must be discarded (back to Resolving),
      // never flashed or retained.
      onNodeWithContentDescription("Retry connecting to the AutoMobile daemon").performClick()
      waitUntil(timeoutMillis = 5_000) { created.size >= 2 }
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Resolving navigation graph", substring = true)
          .fetchSemanticsNodes()
          .isNotEmpty()
      }
      assertTrue(
        "stale pre-outage app A must not survive a reconnect",
        onAllNodesWithText("Alpha").fetchSemanticsNodes().isEmpty(),
      )

      // The fresh stream resolves app B; the facet ends on B, never reverting to A.
      created.last().emitNavigation(navUpdate("com.example.b"))
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Beta").fetchSemanticsNodes().isNotEmpty()
      }
      assertTrue(
        "must not retain app A after resolving app B",
        onAllNodesWithText("Alpha").fetchSemanticsNodes().isEmpty(),
      )
    }

  @Test
  fun `retry after an outage with a null-app stream shows the no-app guidance not the stale app`() =
    runComposeUiTest {
      val created = mutableListOf<FakeObservationStream>()
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            NavigationFacet(
              column = column(),
              observationStreamFactory = { FakeObservationStream().also { created.add(it) } },
              navigationDataSourceProvider = {
                StubNavigationDataSource(
                  Result.Success(NavigationGraph(listOf(screen("Alpha")), emptyList()))
                )
              },
            )
          }
        }
      }
      waitForIdle()

      created.first().emitNavigation(navUpdate("com.example.a"))
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty()
      }
      runOnIdle {
        created.first().emitConnectionState(ConnectionState.Disconnected("Stream ended"))
      }
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithContentDescription("Retry connecting to the AutoMobile daemon")
          .fetchSemanticsNodes()
          .isNotEmpty()
      }

      onNodeWithContentDescription("Retry connecting to the AutoMobile daemon").performClick()
      waitUntil(timeoutMillis = 5_000) { created.size >= 2 }

      // Fresh stream reports no current app: the facet must show the no-app guidance, not the
      // stale pre-outage app.
      created.last().emitNavigation(navUpdate(appId = null))
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Open an app on this device", substring = true)
          .fetchSemanticsNodes()
          .isNotEmpty()
      }
      assertTrue(
        "stale pre-outage app must not survive a reconnect that resolves no app",
        onAllNodesWithText("Alpha").fetchSemanticsNodes().isEmpty(),
      )
    }

  /** A [SharedFlow] that throws on collection, to simulate a stream read/parse failure. */
  private fun throwingNavFlow(error: Throwable): SharedFlow<NavigationGraphStreamUpdate> =
    object : SharedFlow<NavigationGraphStreamUpdate> {
      override val replayCache: List<NavigationGraphStreamUpdate> = emptyList()

      override suspend fun collect(collector: FlowCollector<NavigationGraphStreamUpdate>): Nothing =
        throw error
    }

  @Test
  fun `routes a throwing stream collection to the retryable error state instead of crashing`() =
    runComposeUiTest {
      // A stream whose navigation-updates flow throws on collect. An unguarded LaunchedEffect
      // collect would propagate this to the Recomposer root and crash the app; the facet must
      // instead land in the retryable error state.
      val throwing =
        object : ObservationStream by FakeObservationStream() {
          override val navigationUpdates = throwingNavFlow(RuntimeException("stream read error"))
        }
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            NavigationFacet(
              column = column(),
              observationStreamFactory = { throwing },
              navigationDataSourceProvider = {
                StubNavigationDataSource(Result.Success(NavigationGraph(emptyList(), emptyList())))
              },
            )
          }
        }
      }

      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("stream read error", substring = true).fetchSemanticsNodes().isNotEmpty()
      }
      onNodeWithText("stream read error", substring = true).assertExists()
      onNodeWithContentDescription("Retry connecting to the AutoMobile daemon").assertExists()
      assertTrue(
        "must not be stuck on the indefinite Resolving state",
        onAllNodesWithText("Resolving navigation graph", substring = true)
          .fetchSemanticsNodes()
          .isEmpty(),
      )
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
