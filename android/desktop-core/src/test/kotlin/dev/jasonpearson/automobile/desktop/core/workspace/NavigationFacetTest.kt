package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrap
import dev.jasonpearson.automobile.desktop.core.daemon.FakeObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.NavigationGraphStreamUpdate
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.datasource.DefaultDataSourceFactory
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationGraph
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.AutoMobileGraphProvider
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.navigation.DefaultNavigationScreenshotLoaderRegistry
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationScreenshotLoaderRegistry
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenNode
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenshotLoader
import dev.jasonpearson.automobile.desktop.core.platform.AppVersion
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.core.update.FakeUpdateController
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.SharedFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class NavigationFacetTest {

  /** In-memory graph so nothing the facet touches reaches a real socket. */
  private fun testGraph(): AutoMobileGraphProvider {
    val client = FakeAutoMobileClient()
    return object : AutoMobileGraphProvider {
      override val autoMobileClient = client
      override val daemonBootstrap = DaemonBootstrap.inactive()
      override val settingsProvider = FakeSettingsProvider()
      override val dataSourceFactory = DefaultDataSourceFactory(client)
      override val updateController = FakeUpdateController()
      override val appVersionProvider = AppVersionProvider { AppVersion.Dev }
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
  fun `re-pulls the app graph when a same-app update arrives so the graph grows live`() =
    runComposeUiTest {
      // A stateful source whose snapshot grows on the 2nd pull: Home -> Home + Details. If the
      // facet only re-pulls on appId change, a same-app update would leave callCount at 1 and
      // Details would never render.
      val calls = AtomicInteger(0)
      val growingSource =
        object : NavigationDataSource {
          override suspend fun getNavigationGraph(): Result<NavigationGraph> {
            val screens =
              if (calls.incrementAndGet() >= 2) listOf(screen("Home"), screen("Details"))
              else listOf(screen("Home"))
            return Result.Success(NavigationGraph(screens, emptyList()))
          }
        }
      val fake = FakeObservationStream()
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            NavigationFacet(
              column = column(),
              observationStreamFactory = { fake },
              navigationDataSourceProvider = { growingSource },
            )
          }
        }
      }
      waitForIdle()

      // First app-A update: pull #1 renders the initial graph.
      fake.emitNavigation(navUpdate("com.example.app"))
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Home").fetchSemanticsNodes().isNotEmpty()
      }

      // Second app-A update (app A discovered a new screen): must re-pull and render Details.
      fake.emitNavigation(navUpdate("com.example.app"))
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Details").fetchSemanticsNodes().isNotEmpty()
      }
      onNodeWithText("Details").assertExists()
      assertEquals("a same-app update must trigger a second app-scoped pull", 2, calls.get())
    }

  @Test
  fun `an in-place app switch hides the previous app graph and shows Loading until the new one resolves`() =
    runComposeUiTest {
      // App B's pull is gated so it stays in-flight while we assert app A's graph is hidden.
      val gateB = CompletableDeferred<Unit>()
      val aSource =
        StubNavigationDataSource(
          Result.Success(NavigationGraph(listOf(screen("Alpha")), emptyList()))
        )
      val bSource =
        object : NavigationDataSource {
          override suspend fun getNavigationGraph(): Result<NavigationGraph> {
            gateB.await()
            return Result.Success(NavigationGraph(listOf(screen("Beta")), emptyList()))
          }
        }
      val fake = FakeObservationStream()
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            NavigationFacet(
              column = column(),
              observationStreamFactory = { fake },
              navigationDataSourceProvider = { appId ->
                if (appId == "com.example.b") bSource else aSource
              },
            )
          }
        }
      }
      waitForIdle()

      // Resolve app A; its graph renders.
      fake.emitNavigation(navUpdate("com.example.a"))
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty()
      }

      // Foreground switches to app B (no disconnect). While B's pull is suspended the facet must
      // hide A's graph and show Loading — not keep rendering stale A.
      fake.emitNavigation(navUpdate("com.example.b"))
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Resolving navigation graph", substring = true)
          .fetchSemanticsNodes()
          .isNotEmpty()
      }
      assertTrue(
        "an in-place app switch must hide the previous app's graph",
        onAllNodesWithText("Alpha").fetchSemanticsNodes().isEmpty(),
      )

      // Once B resolves it renders B.
      gateB.complete(Unit)
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Beta").fetchSemanticsNodes().isNotEmpty()
      }
      onNodeWithText("Beta").assertExists()
    }

  @Test
  fun `a same-app refresh keeps the current graph on screen while re-pulling`() = runComposeUiTest {
    // The 2nd (same-app) pull is gated so we can observe the in-flight refresh window.
    val gate = CompletableDeferred<Unit>()
    val calls = AtomicInteger(0)
    val refreshingSource =
      object : NavigationDataSource {
        override suspend fun getNavigationGraph(): Result<NavigationGraph> {
          if (calls.incrementAndGet() >= 2) {
            gate.await()
            return Result.Success(
              NavigationGraph(listOf(screen("Home"), screen("Details")), emptyList())
            )
          }
          return Result.Success(NavigationGraph(listOf(screen("Home")), emptyList()))
        }
      }
    val fake = FakeObservationStream()
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationFacet(
            column = column(),
            observationStreamFactory = { fake },
            navigationDataSourceProvider = { refreshingSource },
          )
        }
      }
    }
    waitForIdle()

    fake.emitNavigation(navUpdate("com.example.app"))
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Home").fetchSemanticsNodes().isNotEmpty()
    }

    // Same-app refresh: the 2nd pull is suspended on the gate. The existing graph must stay on
    // screen (no Loading blank) — this is the round-6 behavior we must not regress.
    fake.emitNavigation(navUpdate("com.example.app"))
    waitUntil(timeoutMillis = 5_000) { calls.get() >= 2 }
    onNodeWithText("Home").assertExists()
    assertTrue(
      "a same-app refresh must not blank the graph to Loading",
      onAllNodesWithText("Resolving navigation graph", substring = true)
        .fetchSemanticsNodes()
        .isEmpty(),
    )

    gate.complete(Unit)
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Details").fetchSemanticsNodes().isNotEmpty()
    }
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
    onNodeWithText("Interact with the app to record its navigation graph.").assertExists()
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
  fun `automatically reconnects at mount when the socket becomes available`() = runComposeUiTest {
    val fake = FakeObservationStream(failConnect = true)
    val socketUp = mutableStateOf(false)
    val backoff = CompletableDeferred<Unit>()
    val controlled =
      object : ObservationStream by fake {
        override fun connect(deviceId: String?, deviceSessionUuid: String?) {
          fake.connect(deviceId, deviceSessionUuid)
          if (socketUp.value) fake.emitConnectionState(ConnectionState.Connected())
        }
      }
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationFacet(
            column = column(),
            observationStreamFactory = { controlled },
            navigationDataSourceProvider = {
              StubNavigationDataSource(
                Result.Success(NavigationGraph(listOf(screen("Home")), emptyList()))
              )
            },
            backoffDelay = { backoff.await() },
            socketAvailable = { socketUp.value },
          )
        }
      }
    }

    // The initial connection fails; show the transport error while the shared lifecycle waits.
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
    onNodeWithText("Reconnecting to the AutoMobile daemon", substring = true).assertExists()
    assertEquals(1, fake.connectCallCount)

    runOnIdle {
      socketUp.value = true
      backoff.complete(Unit)
    }
    waitUntil(timeoutMillis = 5_000) { fake.connectCallCount == 2 }
    waitUntil(timeoutMillis = 5_000) { fake.navigationRequestCount >= 1 }
    fake.emitNavigation(navUpdate("com.example.app"))
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Home").fetchSemanticsNodes().isNotEmpty()
    }
  }

  @Test
  fun `conflated reconnect clears the old app and requests fresh navigation`() = runComposeUiTest {
    val fake = FakeObservationStream()
    val observedStates = CopyOnWriteArrayList<ConnectionState>()
    val downstreamMayResume = CompletableDeferred<Unit>()
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationFacet(
            column = column(),
            observationStreamFactory = { fake },
            navigationDataSourceProvider = {
              StubNavigationDataSource(
                Result.Success(NavigationGraph(listOf(screen("Alpha")), emptyList()))
              )
            },
            backoffDelay = {},
            socketAvailable = { true },
          )
          LaunchedEffect(fake) {
            fake.connectionState.collect {
              observedStates += it
              if (observedStates.size == 1) downstreamMayResume.await()
            }
          }
        }
      }
    }
    waitForIdle()
    fake.emitNavigation(navUpdate("com.example.a"))
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty()
    }
    val requestsBeforeDrop = fake.navigationRequestCount

    runOnIdle { fake.emitConnectionState(ConnectionState.Disconnected("Stream ended")) }
    waitForIdle()
    assertEquals(2, fake.connectCallCount)
    assertEquals(ConnectionState.Connected(), fake.connectionState.value)
    runOnIdle { downstreamMayResume.complete(Unit) }
    waitForIdle()
    assertTrue(
      "the new generation must request a fresh navigation payload",
      fake.navigationRequestCount > requestsBeforeDrop,
    )
    assertTrue(
      "the old app must be hidden even when the state collector missed the drop",
      onAllNodesWithText("Alpha").fetchSemanticsNodes().isEmpty(),
    )
  }

  @Test
  fun `automatically reconnects the same stream after a mid-session drop`() = runComposeUiTest {
    val fake = FakeObservationStream()
    val backoff = CompletableDeferred<Unit>()
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
            backoffDelay = { backoff.await() },
            socketAvailable = { true },
          )
        }
      }
    }
    waitForIdle()

    // App resolves and its graph renders.
    fake.emitNavigation(navUpdate("com.example.app"))
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Home").fetchSemanticsNodes().isNotEmpty()
    }

    runOnIdle { fake.emitConnectionState(ConnectionState.Disconnected("Stream ended")) }
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Stream ended", substring = true).fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("Stream ended", substring = true).assertExists()
    assertEquals(1, fake.connectCallCount)
    assertTrue(
      "old app must be hidden during outage",
      onAllNodesWithText("Home").fetchSemanticsNodes().isEmpty(),
    )

    runOnIdle { backoff.complete(Unit) }
    waitUntil(timeoutMillis = 5_000) { fake.connectCallCount == 2 }
    waitUntil(timeoutMillis = 5_000) { fake.navigationRequestCount >= 2 }
  }

  @Test
  fun `automatic reconnect re-resolves the replacement app without retaining the pre-outage app`() =
    runComposeUiTest {
      val fake = FakeObservationStream()
      val backoff = CompletableDeferred<Unit>()
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            NavigationFacet(
              column = column(),
              observationStreamFactory = { fake },
              navigationDataSourceProvider = { appId ->
                // Distinct graph per app so a stale render is detectable by screen name.
                val label = if (appId == "com.example.b") "Beta" else "Alpha"
                StubNavigationDataSource(
                  Result.Success(NavigationGraph(listOf(screen(label)), emptyList()))
                )
              },
              backoffDelay = { backoff.await() },
              socketAvailable = { true },
            )
          }
        }
      }
      waitForIdle()

      // Resolve app A; its graph renders.
      fake.emitNavigation(navUpdate("com.example.a"))
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty()
      }

      // Stream drops mid-session (user then switches to app B during the outage).
      runOnIdle { fake.emitConnectionState(ConnectionState.Disconnected("Stream ended")) }
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Stream ended", substring = true).fetchSemanticsNodes().isNotEmpty()
      }

      // Backoff reconnects the same stream. The old app is discarded before it connects.
      runOnIdle { backoff.complete(Unit) }
      waitUntil(timeoutMillis = 5_000) { fake.connectCallCount == 2 }
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Resolving navigation graph", substring = true)
          .fetchSemanticsNodes()
          .isNotEmpty()
      }
      assertTrue(
        "stale pre-outage app A must not survive a reconnect",
        onAllNodesWithText("Alpha").fetchSemanticsNodes().isEmpty(),
      )

      // The reconnected stream resolves app B; the facet ends on B, never reverting to A.
      fake.emitNavigation(navUpdate("com.example.b"))
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Beta").fetchSemanticsNodes().isNotEmpty()
      }
      assertTrue(
        "must not retain app A after resolving app B",
        onAllNodesWithText("Alpha").fetchSemanticsNodes().isEmpty(),
      )
    }

  @Test
  fun `automatic reconnect with a null-app update shows guidance instead of the stale app`() =
    runComposeUiTest {
      val fake = FakeObservationStream()
      val backoff = CompletableDeferred<Unit>()
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            NavigationFacet(
              column = column(),
              observationStreamFactory = { fake },
              navigationDataSourceProvider = {
                StubNavigationDataSource(
                  Result.Success(NavigationGraph(listOf(screen("Alpha")), emptyList()))
                )
              },
              backoffDelay = { backoff.await() },
              socketAvailable = { true },
            )
          }
        }
      }
      waitForIdle()

      fake.emitNavigation(navUpdate("com.example.a"))
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty()
      }
      runOnIdle { fake.emitConnectionState(ConnectionState.Disconnected("Stream ended")) }
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Stream ended", substring = true).fetchSemanticsNodes().isNotEmpty()
      }

      runOnIdle { backoff.complete(Unit) }
      waitUntil(timeoutMillis = 5_000) { fake.connectCallCount == 2 }

      // Reconnected stream reports no current app: the facet must show guidance, not the
      // stale pre-outage app.
      fake.emitNavigation(navUpdate(appId = null))
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
      onNodeWithContentDescription("Retry resolving navigation graph").assertExists()
      assertTrue(
        "must not be stuck on the indefinite Resolving state",
        onAllNodesWithText("Resolving navigation graph", substring = true)
          .fetchSemanticsNodes()
          .isEmpty(),
      )
    }

  @Test
  fun `times out to a retryable error when the daemon never sends a navigation payload`() =
    runComposeUiTest {
      val fake = FakeObservationStream()
      // Drive the timeout deterministically with zero wall time: the seam awaits this gate, and the
      // test completes it to fire the timeout. No real delay() under the real-clock test
      // dispatcher.
      val fireTimeout = CompletableDeferred<Unit>()
      val retryTimeout = CompletableDeferred<Unit>()
      val retryStarted = AtomicBoolean(false)
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            NavigationFacet(
              column = column(),
              observationStreamFactory = { fake },
              navigationDataSourceProvider = {
                StubNavigationDataSource(Result.Success(NavigationGraph(emptyList(), emptyList())))
              },
              resolveTimeout = {
                // Mount can relaunch the effect before Retry; all such launches share the first
                // gate. The user action, not the number of launches, selects the retry gate.
                if (!retryStarted.get()) fireTimeout.await() else retryTimeout.await()
              },
            )
          }
        }
      }
      waitForIdle()

      // The stream connects but the daemon never sends a navigation payload (silently no update).
      // Fire the timeout; without the backstop the facet would sit on "Resolving…" forever, but it
      // must instead surface the retryable error.
      fireTimeout.complete(Unit)
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("No navigation data received", substring = true)
          .fetchSemanticsNodes()
          .isNotEmpty()
      }
      onNodeWithText("No navigation data received", substring = true).assertExists()
      onNodeWithContentDescription("Retry resolving navigation graph").assertExists()
      assertTrue(
        "the timeout must not leave the facet stuck on Resolving",
        onAllNodesWithText("Resolving navigation graph", substring = true)
          .fetchSemanticsNodes()
          .isEmpty(),
      )

      // The socket is healthy, so retry requests another payload on the same stream.
      retryStarted.set(true)
      onNodeWithContentDescription("Retry resolving navigation graph").performClick()
      waitUntil(timeoutMillis = 5_000) { fake.navigationRequestCount >= 2 }
      assertEquals("payload retry keeps the healthy stream", 1, fake.connectCallCount)
      onNodeWithText("Resolving navigation graph", substring = true).assertExists()
    }

  @Test
  fun `switching apps resets fog so the new app starts with the full graph`() = runComposeUiTest {
    // App A starts with fog enabled (persisted). Switching to B must not carry A's fog into B.
    val settings = FakeSettingsProvider(fogModeEnabled = true)
    val client = FakeAutoMobileClient()
    val graphProvider =
      object : AutoMobileGraphProvider {
        override val autoMobileClient = client
        override val daemonBootstrap = DaemonBootstrap.inactive()
        override val settingsProvider = settings
        override val dataSourceFactory = DefaultDataSourceFactory(client)
        override val updateController = FakeUpdateController()
        override val appVersionProvider = AppVersionProvider { AppVersion.Dev }
      }
    val fake = FakeObservationStream()
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides graphProvider) {
        MaterialTheme {
          NavigationFacet(
            column = column(),
            observationStreamFactory = { fake },
            navigationDataSourceProvider = { appId ->
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

    fake.emitNavigation(navUpdate("com.example.a", currentScreen = "Alpha"))
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty()
    }
    assertTrue("precondition: app A has fog enabled", settings.fogModeEnabled)

    // Foreground switches to app B: fog must be reset so B shows the full graph, not A's fog focus.
    fake.emitNavigation(navUpdate("com.example.b", currentScreen = "Beta"))
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Beta").fetchSemanticsNodes().isNotEmpty()
    }
    assertFalse("switching to a new app must reset fog", settings.fogModeEnabled)
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

  @Test
  fun `reuses the same screenshot loader across facet open-close toggles`() = runComposeUiTest {
    // A registry held above the facet's composition; the facet must resolve its loader from it each
    // mount so the LRU cache survives the facet leaving and re-entering composition.
    val registry = NavigationScreenshotLoaderRegistry()
    val used = mutableListOf<ScreenshotLoader>()
    val visible = mutableStateOf(true)
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          if (visible.value) {
            NavigationFacet(
              column = column(),
              observationStreamFactory = { FakeObservationStream() },
              screenshotLoaderProvider = { deviceId ->
                registry.forDevice(deviceId) { FakeAutoMobileClient() }.also { used += it }
              },
            )
          }
        }
      }
    }
    waitForIdle()
    // Toggle the facet out of composition (tool switched off) and back on.
    runOnIdle { visible.value = false }
    waitForIdle()
    runOnIdle { visible.value = true }
    waitForIdle()

    assertEquals(
      "the facet must resolve its loader from the hoisted provider on each mount",
      2,
      used.size,
    )
    assertSame("the loader (and its LRU cache) must survive the toggle", used[0], used[1])
  }

  @Test
  fun `default provider resolves through the session registry so real users get a surviving cache`() =
    runComposeUiTest {
      // Exercises the PRODUCTION default (no injected provider). A unique deviceId keeps the
      // process-lifetime registry from colliding with other tests. Guards against a regression that
      // reverts the default to a fresh-per-mount loader (which every provider-injecting test
      // misses).
      val deviceId = "default-wiring-probe-dev-4832"
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            NavigationFacet(
              column = column(deviceId),
              observationStreamFactory = { FakeObservationStream() },
            )
          }
        }
      }
      waitForIdle()
      assertNotNull(
        "the default provider must populate the session registry",
        DefaultNavigationScreenshotLoaderRegistry.peek(deviceId),
      )
    }

  @Test
  fun `swapping the injected loader provider re-resolves the loader`() = runComposeUiTest {
    // Two registries hand out distinct loaders for the same device, so a provider swap must be
    // observable. Guards that the loader `remember` keys on the provider, not just the deviceId.
    val fromReg1 = NavigationScreenshotLoaderRegistry()
    val fromReg2 = NavigationScreenshotLoaderRegistry()
    val used = mutableListOf<ScreenshotLoader>()
    val provider =
      mutableStateOf<(String) -> ScreenshotLoader>({ id ->
        fromReg1.forDevice(id) { FakeAutoMobileClient() }.also { used += it }
      })
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationFacet(
            column = column(),
            observationStreamFactory = { FakeObservationStream() },
            screenshotLoaderProvider = provider.value,
          )
        }
      }
    }
    waitForIdle()
    runOnIdle {
      provider.value = { id ->
        fromReg2.forDevice(id) { FakeAutoMobileClient() }.also { used += it }
      }
    }
    waitForIdle()

    assertEquals("a provider swap must re-resolve the loader", 2, used.size)
    assertNotSame("the loader must come from the new provider after a swap", used[0], used[1])
  }

  private fun screenWithShot(name: String, screenshotUri: String) =
    screen(name).copy(screenshotUri = screenshotUri)

  /** A [ScreenshotLoader] that records load/invalidate calls; returns no bitmap (unused here). */
  private class RecordingScreenshotLoader : ScreenshotLoader {
    // Cross-thread: load() runs on Dispatchers.IO, invalidate() on the composition thread.
    val loaded = CopyOnWriteArrayList<String>()
    val invalidated = CopyOnWriteArrayList<String>()

    override suspend fun load(uri: String): ImageBitmap? {
      loaded += uri
      return null
    }

    override fun invalidate(uri: String) {
      invalidated += uri
    }

    override fun clearCache() = Unit

    override fun cacheSize(): Int = 0
  }

  @Test
  fun `stampScreenshotVersions applies per-node versions and leaves others at zero`() {
    val graph = NavigationGraph(listOf(screen("Home"), screen("Details")), emptyList())
    val stamped = stampScreenshotVersions(graph, mapOf("Home" to 3))
    assertEquals(3, stamped.screens.first { it.name == "Home" }.screenshotVersion)
    assertEquals(0, stamped.screens.first { it.name == "Details" }.screenshotVersion)
  }

  @Test
  fun `stampScreenshotVersions returns the graph unchanged when nothing was re-captured`() {
    val graph = NavigationGraph(listOf(screen("Home")), emptyList())
    assertSame(graph, stampScreenshotVersions(graph, emptyMap()))
  }

  @Test
  fun `same-app refresh invalidates only the re-captured node's cached screenshot`() =
    runComposeUiTest {
      // #5088: the daemon re-captures a node's screenshot under its SAME stable URI, so a URI-keyed
      // thumbnail cache would keep serving the stale bitmap. On a same-app refresh the facet bumps
      // the just-navigated screen's liveness token, and the canvas must drop exactly that node's
      // cache entry — never the untouched siblings'.
      val homeUri = "automobile:navigation/nodes/home/screenshot"
      val detailsUri = "automobile:navigation/nodes/details/screenshot"
      val source =
        object : NavigationDataSource {
          override suspend fun getNavigationGraph(): Result<NavigationGraph> =
            Result.Success(
              NavigationGraph(
                listOf(screenWithShot("Home", homeUri), screenWithShot("Details", detailsUri)),
                emptyList(),
              )
            )
        }
      val loader = RecordingScreenshotLoader()
      val fake = FakeObservationStream()
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            NavigationFacet(
              column = column(),
              observationStreamFactory = { fake },
              navigationDataSourceProvider = { source },
              screenshotLoaderProvider = { loader },
            )
          }
        }
      }
      waitForIdle()

      // First app-A update navigating to Home: initial pull, both cards load, none invalidated
      // (version 0 is already a cache miss).
      fake.emitNavigation(navUpdate("com.example.app", currentScreen = "Home"))
      waitUntil(timeoutMillis = 5_000) { loader.loaded.contains(homeUri) }
      assertTrue("first render must not invalidate anything", loader.invalidated.isEmpty())

      // Second app-A update navigating to Home again (the daemon re-captured Home's screenshot):
      // Home's token bumps, so the canvas invalidates Home's cache entry and re-fetches.
      fake.emitNavigation(navUpdate("com.example.app", currentScreen = "Home"))
      waitUntil(timeoutMillis = 5_000) { loader.invalidated.contains(homeUri) }
      assertFalse(
        "an untouched sibling node's screenshot must not be invalidated",
        loader.invalidated.contains(detailsUri),
      )
    }
}
