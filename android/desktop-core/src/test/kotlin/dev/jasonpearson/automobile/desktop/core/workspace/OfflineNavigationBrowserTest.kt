package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrap
import dev.jasonpearson.automobile.desktop.core.datasource.DefaultDataSourceFactory
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationAppSummary
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.NavigationGraph
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.AutoMobileGraphProvider
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationDashboard
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenNode
import dev.jasonpearson.automobile.desktop.core.platform.AppVersion
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.core.update.FakeUpdateController
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class OfflineNavigationBrowserTest {

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

  private fun screen(name: String) =
    ScreenNode(
      id = name.lowercase(),
      name = name,
      type = "Activity",
      packageName = "com.example.app",
      transitionCount = 0,
      discoveredAt = 0L,
    )

  /** A configurable fake serving both listApps and per-app getNavigationGraph. */
  private class FakeBrowserDataSource(
    private val appsResult: Result<List<NavigationAppSummary>>,
    private val graphResult: Result<NavigationGraph> =
      Result.Success(NavigationGraph(emptyList(), emptyList())),
  ) : NavigationDataSource {
    val graphCalls = AtomicInteger(0)

    override suspend fun getNavigationGraph(): Result<NavigationGraph> {
      graphCalls.incrementAndGet()
      return graphResult
    }

    override suspend fun listApps(): Result<List<NavigationAppSummary>> = appsResult
  }

  /** A fake whose results come from suppliers, so a test can flip error -> success across calls. */
  private class SuppliedDataSource(
    private val apps: () -> Result<List<NavigationAppSummary>> = {
      Result.Success(emptyList())
    },
    private val graph: () -> Result<NavigationGraph> = {
      Result.Success(NavigationGraph(emptyList(), emptyList()))
    },
  ) : NavigationDataSource {
    override suspend fun getNavigationGraph(): Result<NavigationGraph> = graph()

    override suspend fun listApps(): Result<List<NavigationAppSummary>> = apps()
  }

  private fun appSummary(appId: String, displayName: String?, lastUpdated: String = "2026-01-01") =
    NavigationAppSummary(appId = appId, displayName = displayName, lastUpdated = lastUpdated)

  @Test
  fun `lists apps offline with displayName falling back to appId`() = runComposeUiTest {
    val source =
      FakeBrowserDataSource(
        Result.Success(
          listOf(
            appSummary("com.example.shopping", "Shopping"),
            appSummary("com.example.banking", null),
          )
        )
      )
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme { OfflineNavigationBrowser(navigationDataSourceProvider = { source }) }
      }
    }

    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Shopping").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("Shopping").assertExists()
    // Null displayName falls back to the appId as the primary label.
    onNodeWithText("com.example.banking").assertExists()
  }

  @Test
  fun `selecting an app renders the NavigationDashboard from the returned graph`() =
    runComposeUiTest {
      val source =
        FakeBrowserDataSource(
          appsResult = Result.Success(listOf(appSummary("com.example.app", "Sample"))),
          graphResult = Result.Success(NavigationGraph(listOf(screen("Alpha")), emptyList())),
        )
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme { OfflineNavigationBrowser(navigationDataSourceProvider = { source }) }
        }
      }
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Sample").fetchSemanticsNodes().isNotEmpty()
      }

      onNodeWithContentDescription("Open navigation graph for Sample").performClick()

      // The persisted graph is rendered through NavigationDashboard (its canvas draws screen
      // names).
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty()
      }
      onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty()
      assertTrue("graph should be pulled from the data source", source.graphCalls.get() >= 1)
    }

  @Test
  fun `navigate actions are disabled offline once an app is opened`() = runComposeUiTest {
    val source =
      FakeBrowserDataSource(
        appsResult = Result.Success(listOf(appSummary("com.example.app", "Sample"))),
        graphResult = Result.Success(NavigationGraph(listOf(screen("Alpha")), emptyList())),
      )
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme { OfflineNavigationBrowser(navigationDataSourceProvider = { source }) }
      }
    }
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Sample").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithContentDescription("Open navigation graph for Sample").performClick()

    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithContentDescription("Navigate actions disabled (offline)")
        .fetchSemanticsNodes()
        .isNotEmpty()
    }
    onNodeWithContentDescription("Navigate actions disabled (offline)").assertExists()
  }

  @Test
  fun `shows the empty state when no saved graphs exist`() = runComposeUiTest {
    val source = FakeBrowserDataSource(Result.Success(emptyList()))
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme { OfflineNavigationBrowser(navigationDataSourceProvider = { source }) }
      }
    }

    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("No saved navigation graphs").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("No saved navigation graphs").assertExists()
  }

  @Test
  fun `shows a retryable error when the app list fails to load`() = runComposeUiTest {
    val source = FakeBrowserDataSource(Result.Error(RuntimeException("daemon down"), "daemon down"))
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme { OfflineNavigationBrowser(navigationDataSourceProvider = { source }) }
      }
    }

    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("daemon down", substring = true).fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("daemon down", substring = true).assertExists()
    onNodeWithContentDescription("Retry loading saved navigation graphs").assertExists()
  }

  @Test
  fun `app list error then retry loads the apps`() = runComposeUiTest {
    val attempts = AtomicInteger(0)
    val source =
      SuppliedDataSource(
        apps = {
          if (attempts.getAndIncrement() == 0)
            Result.Error(RuntimeException("daemon down"), "daemon down")
          else Result.Success(listOf(appSummary("com.example.app", "Sample")))
        }
      )
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme { OfflineNavigationBrowser(navigationDataSourceProvider = { source }) }
      }
    }
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("daemon down", substring = true).fetchSemanticsNodes().isNotEmpty()
    }

    onNodeWithContentDescription("Retry loading saved navigation graphs").performClick()
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Sample").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("Sample").assertExists()
  }

  @Test
  fun `app graph error then retry renders the graph`() = runComposeUiTest {
    val attempts = AtomicInteger(0)
    val source =
      SuppliedDataSource(
        apps = { Result.Success(listOf(appSummary("com.example.app", "Sample"))) },
        graph = {
          if (attempts.getAndIncrement() == 0)
            Result.Error(RuntimeException("graph gone"), "graph gone")
          else Result.Success(NavigationGraph(listOf(screen("Alpha")), emptyList()))
        },
      )
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme { OfflineNavigationBrowser(navigationDataSourceProvider = { source }) }
      }
    }
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Sample").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithContentDescription("Open navigation graph for Sample").performClick()
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("graph gone", substring = true).fetchSemanticsNodes().isNotEmpty()
    }

    onNodeWithContentDescription("Retry loading navigation graph").performClick()
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty()
    }
    onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty()
  }

  @Test
  fun `switching apps after Back renders the new app graph not the previous one`() =
    runComposeUiTest {
      // Distinct graph per appId so a stale render is detectable by screen name.
      val provider: (String?) -> NavigationDataSource = { appId ->
        when (appId) {
          null ->
            SuppliedDataSource(
              apps = {
                Result.Success(
                  listOf(appSummary("com.example.a", "AppA"), appSummary("com.example.b", "AppB"))
                )
              }
            )
          "com.example.a" ->
            SuppliedDataSource(
              graph = { Result.Success(NavigationGraph(listOf(screen("Alpha")), emptyList())) }
            )
          else ->
            SuppliedDataSource(
              graph = { Result.Success(NavigationGraph(listOf(screen("Beta")), emptyList())) }
            )
        }
      }
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme { OfflineNavigationBrowser(navigationDataSourceProvider = provider) }
        }
      }
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("AppA").fetchSemanticsNodes().isNotEmpty()
      }

      onNodeWithContentDescription("Open navigation graph for AppA").performClick()
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty()
      }

      onNodeWithContentDescription("Back to saved navigation graphs").performClick()
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("AppB").fetchSemanticsNodes().isNotEmpty()
      }

      onNodeWithContentDescription("Open navigation graph for AppB").performClick()
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithText("Beta").fetchSemanticsNodes().isNotEmpty()
      }
      assertTrue(
        "app B's graph must render, not the previously-opened app A's",
        onAllNodesWithText("Alpha").fetchSemanticsNodes().isEmpty(),
      )
    }

  @Test
  fun `offline browse does not fetch a mis-scoped node screenshot`() = runComposeUiTest {
    // The daemon's node-screenshot resource resolves via getCurrentAppId(), not the browsed app,
    // so offline thumbnails could render the wrong app's image. The offline path wires no
    // screenshot loader; prove it never reads the screenshot resource even when a node carries a
    // screenshotUri. A real loader would call client.readResource on render of the node card.
    val client = FakeAutoMobileClient()
    val graphProvider =
      object : AutoMobileGraphProvider {
        override val autoMobileClient = client
        override val daemonBootstrap = DaemonBootstrap.inactive()
        override val settingsProvider = FakeSettingsProvider()
        override val dataSourceFactory = DefaultDataSourceFactory(client)
        override val updateController = FakeUpdateController()
        override val appVersionProvider = AppVersionProvider { AppVersion.Dev }
      }
    val nodeWithShot =
      screen("Alpha").copy(screenshotUri = "automobile:navigation/nodes/1/screenshot")
    val source =
      FakeBrowserDataSource(
        appsResult = Result.Success(listOf(appSummary("com.example.app", "Sample"))),
        graphResult = Result.Success(NavigationGraph(listOf(nodeWithShot), emptyList())),
      )
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides graphProvider) {
        MaterialTheme { OfflineNavigationBrowser(navigationDataSourceProvider = { source }) }
      }
    }
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Sample").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithContentDescription("Open navigation graph for Sample").performClick()
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty()
    }

    assertTrue(
      "offline browse must not read the (mis-scoped) node-screenshot resource",
      client.calls.none { it == "readResource" },
    )
  }

  @Test
  fun `read-only badge is absent when the dashboard is online`() = runComposeUiTest {
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationDashboard(
            providedGraph = NavigationGraph(listOf(screen("Alpha")), emptyList()),
            readOnly = false,
          )
        }
      }
    }
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty()
    }
    // Online: no offline read-only badge.
    assertTrue(
      "navigate actions must not be marked disabled when online",
      onAllNodesWithContentDescription("Navigate actions disabled (offline)")
        .fetchSemanticsNodes()
        .isEmpty(),
    )
  }
}
