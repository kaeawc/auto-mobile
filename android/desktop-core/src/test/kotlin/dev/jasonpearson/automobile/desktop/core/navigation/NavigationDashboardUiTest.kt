package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.domain.ScreenNode
import dev.jasonpearson.automobile.desktop.domain.ScreenTransition
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class NavigationDashboardUiTest {

  private val sampleScreens =
      listOf(
          ScreenNode("s1", "Login", "Composable", "com.app.auth", 3, 1000L),
          ScreenNode("s2", "Home", "Activity", "com.app.main", 5, 2000L),
          ScreenNode("s3", "Settings", "Composable", "com.app.settings", 1, 3000L),
      )

  private val sampleTransitions =
      listOf(
          ScreenTransition("t1", "Login", "Home", "tap", "Login Button", 350, 0.03f),
          ScreenTransition("t2", "Home", "Settings", "tap", "Settings Tab", 50, 0.0f),
          ScreenTransition("t3", "Settings", "Home", "back", null, 40, 0.0f),
      )

  // -- FlowMapListView tests --

  @Test
  fun `flow map shows screen and transition counts`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FlowMapListView(
            screens = sampleScreens,
            transitions = sampleTransitions,
            onScreenSelected = {},
            onTransitionSelected = {},
        )
      }
    }
    onNodeWithText("Flow Map").assertIsDisplayed()
    onNodeWithText("3 screens discovered \u2022 3 transitions").assertIsDisplayed()
    onNodeWithText("Screens").assertIsDisplayed()
    onNodeWithText("Transitions").assertIsDisplayed()
  }

  @Test
  fun `flow map shows screen names`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FlowMapListView(
            screens = sampleScreens,
            transitions = sampleTransitions,
            onScreenSelected = {},
            onTransitionSelected = {},
        )
      }
    }
    // Screen names may appear in both screen rows and transition rows,
    // so use onAllNodesWithText to verify at least one instance is displayed
    onAllNodesWithText("Login").onFirst().assertIsDisplayed()
    onAllNodesWithText("Home").onFirst().assertIsDisplayed()
    onAllNodesWithText("Settings").onFirst().assertIsDisplayed()
  }

  @Test
  fun `flow map with empty data shows zero counts`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FlowMapListView(
            screens = emptyList(),
            transitions = emptyList(),
            onScreenSelected = {},
            onTransitionSelected = {},
        )
      }
    }
    onNodeWithText("0 screens discovered \u2022 0 transitions").assertIsDisplayed()
  }

  // -- ScreenDetailView tests --

  @Test
  fun `screen detail shows screen name and type`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ScreenDetailView(
            screen = sampleScreens[0],
            transitions = sampleTransitions,
            onBack = {},
            onScreenSelected = {},
        )
      }
    }
    // "Login" appears in both the header and transition rows
    onAllNodesWithText("Login").onFirst().assertIsDisplayed()
    onNodeWithText("Composable").assertIsDisplayed()
    onNodeWithText("com.app.auth").assertIsDisplayed()
  }

  @Test
  fun `screen detail shows outgoing and incoming counts`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ScreenDetailView(
            screen = sampleScreens[1], // Home
            transitions = sampleTransitions,
            onBack = {},
            onScreenSelected = {},
        )
      }
    }
    // Home has 1 outgoing (Home -> Settings) and 2 incoming (Login -> Home, Settings -> Home)
    onNodeWithText("Outgoing").assertIsDisplayed()
    onNodeWithText("Incoming").assertIsDisplayed()
    onNodeWithText("1").assertIsDisplayed() // outgoing count
    onNodeWithText("2").assertIsDisplayed() // incoming count
  }

  @Test
  fun `screen detail shows no screenshot placeholder`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ScreenDetailView(
            screen = sampleScreens[0],
            transitions = emptyList(),
            onBack = {},
            onScreenSelected = {},
        )
      }
    }
    onNodeWithText("No screenshot").assertIsDisplayed()
  }

  @Test
  fun `screen detail shows back link`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ScreenDetailView(
            screen = sampleScreens[0],
            transitions = emptyList(),
            onBack = {},
            onScreenSelected = {},
        )
      }
    }
    onNodeWithText("\u2190 Flow Map").assertIsDisplayed()
  }

  // -- TransitionDetailView tests --

  @Test
  fun `transition detail shows from and to screens`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TransitionDetailView(
            transition = sampleTransitions[0], // Login -> Home
            onBack = {},
            onScreenSelected = {},
        )
      }
    }
    onNodeWithText("Transition Detail").assertIsDisplayed()
    onNodeWithText("Login").assertIsDisplayed()
    onNodeWithText("Home").assertIsDisplayed()
  }

  @Test
  fun `transition detail shows trigger and element`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TransitionDetailView(
            transition = sampleTransitions[0], // tap, "Login Button"
            onBack = {},
            onScreenSelected = {},
        )
      }
    }
    onNodeWithText("Tap").assertIsDisplayed()
    onNodeWithText("Login Button").assertIsDisplayed()
  }

  @Test
  fun `transition detail shows latency when present`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TransitionDetailView(
            transition = sampleTransitions[0], // avgLatencyMs = 350
            onBack = {},
            onScreenSelected = {},
        )
      }
    }
    onNodeWithText("350ms").assertIsDisplayed()
  }

  @Test
  fun `transition detail shows failure rate when present`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TransitionDetailView(
            transition = sampleTransitions[0], // failureRate = 0.03
            onBack = {},
            onScreenSelected = {},
        )
      }
    }
    onNodeWithText("3.0%").assertIsDisplayed()
  }

  @Test
  fun `transition detail hides latency when zero`() = runComposeUiTest {
    val noLatency = ScreenTransition("t", "A", "B", "tap", null, 0, 0.0f)
    setContent {
      MaterialTheme {
        TransitionDetailView(
            transition = noLatency,
            onBack = {},
            onScreenSelected = {},
        )
      }
    }
    onNodeWithText("Avg Latency").assertDoesNotExist()
  }

  // -- StatItem tests --

  @Test
  fun `stat item shows label and value`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StatItem(label = "Outgoing", value = "5")
      }
    }
    onNodeWithText("Outgoing").assertIsDisplayed()
    onNodeWithText("5").assertIsDisplayed()
  }

  // -- DetailRow tests --

  @Test
  fun `detail row shows label and value`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DetailRow(label = "Trigger", value = "Tap")
      }
    }
    onNodeWithText("Trigger").assertIsDisplayed()
    onNodeWithText("Tap").assertIsDisplayed()
  }
}
