package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.dp
import kotlin.test.assertEquals
import org.junit.Test

/**
 * The shell's chrome is the shared `shell/` components, not private copies (issue #4017): the pane
 * toggles are [PaneToggleToolbar] and the title-bar inset is [MacOSTitleBarSpacer].
 */
@OptIn(ExperimentalTestApi::class)
class ThreePaneShellChromeUiTest {

  @Test
  fun `shell pane toggles reflect visibility and fire their own callbacks`() = runComposeUiTest {
    val toggled = mutableListOf<String>()
    setContent {
      MaterialTheme {
        ThreePaneShell(
          options =
            ThreePaneShellOptions(
              showLeftPane = true,
              onToggleLeftPane = { toggled.add("left") },
              showRightPane = false,
              onToggleRightPane = { toggled.add("right") },
              showBottomPane = true,
              onToggleBottomPane = { toggled.add("bottom") },
              deviceName = null,
              foregroundApp = null,
              crashCount = 0,
              anrCount = 0,
              nonFatalCount = 0,
              toolFailureCount = 0,
              currentFps = null,
              currentMemoryMb = null,
              isDaemonConnected = false,
              centerContent = {},
              leftPaneContent = {},
              rightPaneContent = {},
              bottomPaneContent = {},
            ),
        )
      }
    }

    onNodeWithContentDescription("Toggle left pane").assertIsSelected()
    onNodeWithContentDescription("Toggle bottom pane").assertIsSelected()
    onNodeWithContentDescription("Toggle right pane").assertIsNotSelected()

    onNodeWithContentDescription("Toggle right pane").performClick()
    onNodeWithContentDescription("Toggle left pane").performClick()
    onNodeWithContentDescription("Toggle bottom pane").performClick()

    assertEquals(listOf("right", "left", "bottom"), toggled)
  }

  @Test
  fun `title bar inset is reserved only on macOS`() {
    assertEquals(28.dp, titleBarInset(DesktopPlatform.MacOS))
    assertEquals(0.dp, titleBarInset(DesktopPlatform.Windows))
    assertEquals(0.dp, titleBarInset(DesktopPlatform.Linux))
  }

  @Test
  fun `title bar spacer takes the inset height on macOS`() = runComposeUiTest {
    setContent {
      Column(Modifier.testTag("chrome")) {
        MacOSTitleBarSpacer(platform = DesktopPlatform.MacOS)
      }
    }
    onNodeWithTag("chrome").assertHeightIsEqualTo(28.dp)
  }

  @Test
  fun `title bar spacer takes no height elsewhere`() = runComposeUiTest {
    setContent {
      Column(Modifier.testTag("chrome")) {
        MacOSTitleBarSpacer(platform = DesktopPlatform.Linux)
      }
    }
    onNodeWithTag("chrome").assertHeightIsEqualTo(0.dp)
  }
}
