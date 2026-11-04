package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonBootstrap
import dev.jasonpearson.automobile.desktop.core.datasource.DefaultDataSourceFactory
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.AutoMobileGraphProvider
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.ACTIVE_DEVICE
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.activeContext
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.seen
import dev.jasonpearson.automobile.desktop.core.navigation.MultiBuildNavigationFixture.v2
import dev.jasonpearson.automobile.desktop.core.platform.AppVersion
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.core.update.FakeUpdateController
import dev.jasonpearson.automobile.desktop.domain.NavigationGraph
import kotlin.test.assertEquals
import kotlinx.coroutines.runBlocking
import org.junit.Test

/**
 * The transition detail's navigate action (#16953), driven by a fake navigator over the multi-build
 * fixture's data source. The host re-reads the graph after a reached attempt, as the navigation
 * facet does, with the fake recording the traversal under the active build.
 */
@OptIn(ExperimentalTestApi::class)
class EdgeNavigationUiTest {

  private val source = FakeMultiBuildNavigationDataSource()
  private val initial: NavigationGraph = runBlocking {
    (source.getNavigationGraph() as Result.Success).data
  }

  /** Fake device: reaches [reachable] targets and records them under the active build. */
  private class FakeDevice(private val reachable: Set<String>) : EdgeNavigator {
    val requests = mutableListOf<Pair<String, String>>()

    override suspend fun navigateTo(deviceId: String, targetScreen: String): EdgeNavigationResult {
      requests += deviceId to targetScreen
      val reached = targetScreen in reachable
      return EdgeNavigationResult(reached, if (reached) targetScreen else "Home")
    }
  }

  /** The graph after the daemon records a traversal of [transitionId] on the active build. */
  private fun recorded(graph: NavigationGraph, transitionId: String) =
    graph.copy(
      transitions =
        graph.transitions.map {
          if (it.id == transitionId) it.copy(provenance = it.provenance + seen(v2, ACTIVE_DEVICE))
          else it
        },
    )

  @Composable
  private fun Host(transitionId: String, options: NavigationDashboardOptions) {
    var graph by remember { mutableStateOf(initial) }
    val hostOptions = options.copy(onEdgeNavigated = { graph = recorded(graph, transitionId) })
    val state = remember { NavigationDashboardState(hostOptions) }
    val transition = graph.transitions.single { it.id == transitionId }
    val verification = NavigationBuildLens.verification(transition, hostOptions.activeContext)
    MaterialTheme {
      TransitionDetailView(
        transition = transition,
        onBack = {},
        onScreenSelected = {},
        verification = verification,
        navigateAction = rememberNavigateAction(state, hostOptions, transition, verification),
      )
    }
  }

  private fun ComposeUiTest.showToLogin(options: NavigationDashboardOptions) {
    setContent { Host("toLogin", options) }
  }

  @Test
  fun `speculative attempt is labelled before and after and becomes verified`() = runComposeUiTest {
    val device = FakeDevice(reachable = setOf("Login"))
    showToLogin(
      NavigationDashboardOptions(
        providedGraph = initial,
        activeContext = activeContext,
        edgeNavigator = device,
      ),
    )
    val before = "Try speculative navigation: Home → Login — ${EdgeNavigation.SPECULATIVE_WARNING}"
    onNodeWithContentDescription(before).assertExists()
    onNodeWithText(EdgeNavigation.SPECULATIVE_WARNING).assertExists()

    onNodeWithContentDescription(before).performClick()
    val after = "Speculative attempt reached Login — now verified for the active build"
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithContentDescription(after).fetchSemanticsNodes().isNotEmpty()
    }
    assertEquals(listOf(ACTIVE_DEVICE to "Login"), device.requests)
    // Verified now: the unverified tag and the speculative warning are gone.
    onAllNodesWithContentDescription("Home → Login — unverified for the active build")
      .assertCountEquals(0)
    onAllNodesWithText(EdgeNavigation.SPECULATIVE_WARNING).assertCountEquals(0)
    onNodeWithText("Navigate device along this transition").assertExists()
  }

  @Test
  fun `speculative attempt that misses says the path may not exist`() = runComposeUiTest {
    showToLogin(
      NavigationDashboardOptions(
        providedGraph = initial,
        activeContext = activeContext,
        edgeNavigator = FakeDevice(reachable = emptySet()),
      ),
    )
    onNodeWithText("Try speculative navigation").performClick()
    val after =
      "Speculative attempt did not reach Login (stopped on Home); the path may not exist in " +
        "this build"
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithContentDescription(after).fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithContentDescription("Home → Login — unverified for the active build").assertExists()
  }

  @Test
  fun `read-only browse shows the action disabled and never navigates`() = runComposeUiTest {
    val device = FakeDevice(reachable = setOf("Login"))
    showToLogin(
      NavigationDashboardOptions(
        providedGraph = initial,
        activeContext = null,
        readOnly = true,
        edgeNavigator = device,
      ),
    )
    val disabled = "Navigate actions disabled (offline): Home → Login"
    onNodeWithContentDescription(disabled).performClick()
    waitForIdle()
    assertEquals(emptyList(), device.requests)
  }

  @Test
  fun `no navigator and not read-only shows no action`() = runComposeUiTest {
    showToLogin(NavigationDashboardOptions(providedGraph = initial, activeContext = activeContext))
    onAllNodesWithText("Try speculative navigation").assertCountEquals(0)
  }

  @Test
  fun `dashboard reaches the navigate action from a screen's transition details`() =
    runComposeUiTest {
      setContent {
        CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
          MaterialTheme {
            NavigationDashboard(
              options =
                NavigationDashboardOptions(
                  providedGraph = initial,
                  providedCurrentScreen = "Home",
                  activeContext = activeContext,
                  edgeNavigator = FakeDevice(reachable = setOf("Login")),
                ),
            )
          }
        }
      }
      val home = "Home — active in current context"
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithContentDescription(home).fetchSemanticsNodes().isNotEmpty()
      }
      onNodeWithContentDescription(home).performClick()
      val details = "Transition details: Home → Login"
      waitUntil(timeoutMillis = 5_000) {
        onAllNodesWithContentDescription(details).fetchSemanticsNodes().isNotEmpty()
      }
      onNodeWithContentDescription(details).performScrollTo().performClick()
      onNodeWithContentDescription(
          "Try speculative navigation: Home → Login — ${EdgeNavigation.SPECULATIVE_WARNING}",
        )
        .assertExists()
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
}
