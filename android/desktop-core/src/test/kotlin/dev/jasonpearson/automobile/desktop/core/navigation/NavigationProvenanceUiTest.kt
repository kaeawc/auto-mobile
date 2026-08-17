package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.datasource.DefaultDataSourceFactory
import dev.jasonpearson.automobile.desktop.core.di.AutoMobileGraphProvider
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.platform.AppVersion
import dev.jasonpearson.automobile.desktop.core.platform.AppVersionProvider
import dev.jasonpearson.automobile.desktop.core.settings.FakeSettingsProvider
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.core.update.FakeUpdateController
import dev.jasonpearson.automobile.desktop.domain.NavigationGraph
import org.junit.Test

/**
 * AC2/AC3/AC5 (#4985): rendering the app-union graph with provenance-weighted opacity through the
 * full [NavigationDashboard], asserting on the per-node provenance `contentDescription` (the
 * established accessible/testable channel — opacity itself is not directly assertable).
 */
@OptIn(ExperimentalTestApi::class)
class NavigationProvenanceUiTest {

  private val activeDevice = "emulator-5554"
  private val activeContext =
    NavigationActiveContext(deviceId = activeDevice, packageId = "com.example.app")

  private fun testGraph(): AutoMobileGraphProvider {
    val client = FakeAutoMobileClient()
    return object : AutoMobileGraphProvider {
      override val autoMobileClient = client
      override val settingsProvider = FakeSettingsProvider()
      override val dataSourceFactory = DefaultDataSourceFactory(client)
      override val updateController = FakeUpdateController()
      override val appVersionProvider = AppVersionProvider { AppVersion.Dev }
    }
  }

  private fun provenance(deviceId: String, versionCode: Int = 1, contentHash: String = "hashA") =
    ScreenProvenance(
      buildKey = ProvenanceBuildKey("com.example.app", versionCode, contentHash),
      deviceId = deviceId,
      sessionUuid = "session-1",
      lastSeen = 250L,
    )

  private fun node(name: String, provenance: List<ScreenProvenance>) =
    ScreenNode(
      id = name.lowercase(),
      name = name,
      type = "Activity",
      packageName = "com.example.app",
      transitionCount = 0,
      discoveredAt = 0L,
      provenance = provenance,
    )

  @Test
  fun `active and historical nodes get distinct provenance descriptions`() = runComposeUiTest {
    val graph =
      NavigationGraph(
        screens =
          listOf(
            node("Home", listOf(provenance(deviceId = activeDevice))),
            node(
              "Legacy",
              listOf(
                provenance(deviceId = "emulator-9999", versionCode = 2, contentHash = "hashB")
              ),
            ),
          ),
        transitions = emptyList(),
      )

    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationDashboard(
            providedGraph = graph,
            providedCurrentScreen = "Home",
            activeContext = activeContext,
          )
        }
      }
    }

    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithContentDescription("Home — active in current context")
        .fetchSemanticsNodes()
        .isNotEmpty()
    }
    onNodeWithContentDescription("Home — active in current context").assertExists()
    onNodeWithContentDescription(
        "Legacy — historical: build v2 (hashB), device emulator-9999, session session-1, last seen 250"
      )
      .assertExists()
  }

  @Test
  fun `hovering a faded node reveals its provenance in the visible tooltip`() = runComposeUiTest {
    val graph =
      NavigationGraph(
        screens =
          listOf(
            node(
              "Legacy",
              listOf(
                provenance(deviceId = "emulator-9999", versionCode = 2, contentHash = "hashB")
              ),
            )
          ),
        transitions = emptyList(),
      )

    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationDashboard(
            providedGraph = graph,
            providedCurrentScreen = "Legacy",
            activeContext = activeContext,
          )
        }
      }
    }

    val provenanceText =
      "Legacy — historical: build v2 (hashB), device emulator-9999, session session-1, last seen 250"

    // The provenance lives in semantics from first render, but is NOT yet shown as visible tooltip
    // text — a sighted mouse user only sees it after hovering the node.
    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithContentDescription(provenanceText).fetchSemanticsNodes().isNotEmpty()
    }
    onAllNodesWithText(provenanceText).assertCountEquals(0)

    // Hover the faded node; the TooltipArea popup must surface the same provenance as visible text.
    onNodeWithContentDescription(provenanceText).performMouseInput { moveTo(center) }

    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithText(provenanceText).fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText(provenanceText).assertExists()
  }

  @Test
  fun `active wins when a node is reached in both active and other contexts`() = runComposeUiTest {
    val graph =
      NavigationGraph(
        screens =
          listOf(
            node(
              "Shared",
              listOf(
                provenance(deviceId = "emulator-9999", versionCode = 2, contentHash = "hashB"),
                provenance(deviceId = activeDevice),
              ),
            )
          ),
        transitions = emptyList(),
      )

    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationDashboard(
            providedGraph = graph,
            providedCurrentScreen = "Shared",
            activeContext = activeContext,
          )
        }
      }
    }

    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithContentDescription("Shared — active in current context")
        .fetchSemanticsNodes()
        .isNotEmpty()
    }
    onNodeWithContentDescription("Shared — active in current context").assertExists()
  }

  @Test
  fun `offline (null active context) renders union without fade`() = runComposeUiTest {
    val graph =
      NavigationGraph(
        screens = listOf(node("Home", listOf(provenance(deviceId = "emulator-9999")))),
        transitions = emptyList(),
      )

    setContent {
      CompositionLocalProvider(LocalAutoMobileGraph provides testGraph()) {
        MaterialTheme {
          NavigationDashboard(
            providedGraph = graph,
            providedCurrentScreen = "Home",
            readOnly = true,
          )
        }
      }
    }

    waitUntil(timeoutMillis = 5_000) {
      onAllNodesWithContentDescription("Home — union view (no active context)")
        .fetchSemanticsNodes()
        .isNotEmpty()
    }
    onNodeWithContentDescription("Home — union view (no active context)").assertExists()
  }
}
