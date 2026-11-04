package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrap
import dev.jasonpearson.automobile.desktop.core.datasource.DefaultDataSourceFactory
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.AutoMobileGraphProvider
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.activeContext
import dev.jasonpearson.automobile.desktop.core.platform.AppVersion
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.core.update.FakeUpdateController
import dev.jasonpearson.automobile.desktop.domain.NavigationGraph
import kotlinx.coroutines.runBlocking
import org.junit.Test

/**
 * The build lens rendered through [NavigationDashboard] (#4987): filter (fade and hide), the
 * side-by-side two-build compare, and the unverified-for-the-active-build edge marking. Asserts on
 * the accessible `contentDescription` channel, as the Phase 2 provenance UI tests do.
 */
@OptIn(ExperimentalTestApi::class)
class NavigationBuildLensUiTest {

  private val graph: NavigationGraph = runBlocking {
    (FakeMultiBuildNavigationDataSource().getNavigationGraph() as Result.Success).data
  }

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

  private fun ComposeUiTest.showDashboard() {
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationDashboard(
            options =
              NavigationDashboardOptions(
                providedGraph = graph,
                providedCurrentScreen = "Home",
                activeContext = activeContext,
              ),
          )
        }
      }
    }
  }

  private fun ComposeUiTest.awaitDescription(description: String) {
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithContentDescription(description).fetchSemanticsNodes().isNotEmpty()
    }
  }

  @Test
  fun `filtering by build fades nodes outside it`() = runComposeUiTest {
    showDashboard()
    awaitDescription("Build lens: all builds")

    onNodeWithContentDescription("Build lens: filter v1 (hashA)").performClick()

    awaitDescription("Search — not in build v1 (hashA)")
    onNodeWithContentDescription("Login — in build v1 (hashA)").assertExists()
    onNodeWithContentDescription("Legacy — no build recorded").assertExists()
  }

  @Test
  fun `hiding other builds removes their nodes from the canvas`() = runComposeUiTest {
    showDashboard()
    awaitDescription("Build lens: all builds")

    onNodeWithContentDescription("Build lens: filter v1 (hashA)").performClick()
    awaitDescription("Build lens: hide other builds")
    onNodeWithContentDescription("Build lens: hide other builds").performClick()

    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithContentDescription("Search — not in build v1 (hashA)")
        .fetchSemanticsNodes()
        .isEmpty()
    }
    onNodeWithContentDescription("Login — in build v1 (hashA)").assertExists()

    // Back to the union restores Phase 2 provenance descriptions.
    onNodeWithContentDescription("Build lens: all builds").performClick()
    awaitDescription("Search — active in current context")
  }

  @Test
  fun `compare renders each build's exclusive screens and transitions side by side`() =
    runComposeUiTest {
      showDashboard()
      awaitDescription("Build lens: compare builds")

      onNodeWithContentDescription("Build lens: compare builds").performClick()

      // Default compare: newest build (A = v2) against the next (B = v1).
      awaitDescription("Only in A: screen Search")
      onNodeWithContentDescription("Only in A: transition Home → Search").assertExists()
      onNodeWithContentDescription("Only in B: screen Login").assertExists()
      onNodeWithContentDescription("Only in B: transition Home → Login").assertExists()
      onAllNodesWithContentDescription("Only in A: screen Home").assertCountEquals(0)

      // Swap side A to v1: the two builds now match on A's side and the diff empties.
      onNodeWithContentDescription("Compare A: v1 (hashA)").performClick()
      awaitDescription("No differences: 2 screens and 2 transitions in both builds")
    }

  @Test
  fun `lens bar is hidden when only one build was observed`() = runComposeUiTest {
    val single =
      NavigationGraph(
        screens = graph.screens.filter { it.name != "Login" },
        transitions = graph.transitions.filter { it.id == "toSearch" },
      )
    val v2Only =
      single.copy(
        screens =
          single.screens.map { screen ->
            screen.copy(
              provenance =
                screen.provenance.filter { it.buildKey == MultiBuildNavigationFixture.v2 },
            )
          },
      )
    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationDashboard(
            options =
              NavigationDashboardOptions(
                providedGraph = v2Only,
                providedCurrentScreen = "Home",
                activeContext = activeContext,
              ),
          )
        }
      }
    }
    awaitDescription("Search — active in current context")
    onAllNodesWithContentDescription("Build lens: all builds").assertCountEquals(0)
  }

  @Test
  fun `screen detail marks an edge reached only by another build as unverified`() =
    runComposeUiTest {
      val home = graph.screens.single { it.name == "Home" }
      setContent {
        MaterialTheme {
          ScreenDetailView(
            screen = home,
            transitions = graph.transitions,
            onBack = {},
            onScreenSelected = {},
            environment = ScreenDetailEnvironment(activeContext = activeContext),
          )
        }
      }
      onNodeWithContentDescription("Home → Login — unverified for the active build").assertExists()
      onAllNodesWithContentDescription("Home → Search — unverified for the active build")
        .assertCountEquals(0)
      onAllNodesWithContentDescription("Login → Home — unverified for the active build")
        .assertCountEquals(0)
    }

  @Test
  fun `offline screen detail flags nothing`() = runComposeUiTest {
    val home = graph.screens.single { it.name == "Home" }
    setContent {
      MaterialTheme {
        ScreenDetailView(
          screen = home,
          transitions = graph.transitions,
          onBack = {},
          onScreenSelected = {},
          environment = ScreenDetailEnvironment(activeContext = null),
        )
      }
    }
    onAllNodesWithContentDescription("Home → Login — unverified for the active build")
      .assertCountEquals(0)
  }

  @Test
  fun `transition detail shows the unverified marking`() = runComposeUiTest {
    val toLogin = graph.transitions.single { it.id == "toLogin" }
    setContent {
      MaterialTheme {
        TransitionDetailView(
          transition = toLogin,
          onBack = {},
          onScreenSelected = {},
          verification = NavigationBuildLens.verification(toLogin, activeContext),
        )
      }
    }
    onNodeWithContentDescription("Home → Login — unverified for the active build").assertExists()
  }
}
