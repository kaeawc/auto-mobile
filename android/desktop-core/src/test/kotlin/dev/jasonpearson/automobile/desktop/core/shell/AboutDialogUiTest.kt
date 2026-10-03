package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.click
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.platform.AppVersion
import kotlin.test.assertEquals
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class AboutDialogUiTest {
  @Test
  fun `shows app name version and project URL`() = runComposeUiTest {
    setContent { MaterialTheme { AboutDialog(version = AppVersion.of("1.2.3"), onDismiss = {}) } }
    onNodeWithText("AutoMobile").assertIsDisplayed()
    onNodeWithText("Version 1.2.3").assertIsDisplayed()
    onNodeWithText(ABOUT_PROJECT_URL).assertIsDisplayed()
  }

  @Test
  fun `Close invokes dismissal`() = runComposeUiTest {
    var dismissals = 0
    setContent {
      MaterialTheme { AboutDialog(version = AppVersion.Dev, onDismiss = { dismissals++ }) }
    }
    onNodeWithText("Close").performClick()
    assertEquals(1, dismissals)
  }

  @Test
  fun `Escape invokes dismissal`() = runComposeUiTest {
    var dismissals = 0
    setContent {
      MaterialTheme { AboutDialog(version = AppVersion.Dev, onDismiss = { dismissals++ }) }
    }
    onRoot().performKeyInput { pressKey(Key.Escape) }
    assertEquals(1, dismissals)
  }

  @Test
  fun `project URL invokes injected callback without dismissal`() = runComposeUiTest {
    var opens = 0
    var dismissals = 0
    setContent {
      MaterialTheme {
        AboutDialog(
          version = AppVersion.Dev,
          onDismiss = { dismissals++ },
          onOpenProjectUrl = { opens++ },
        )
      }
    }
    onNodeWithText(ABOUT_PROJECT_URL).performClick()
    assertEquals(1, opens)
    assertEquals(0, dismissals)
    // Escape still works after focus moves to the project link.
    onRoot().performKeyInput { pressKey(Key.Escape) }
    assertEquals(1, dismissals)
  }

  @Test
  fun `backdrop click invokes dismissal`() = runComposeUiTest {
    var dismissals = 0
    setContent {
      MaterialTheme { AboutDialog(version = AppVersion.Dev, onDismiss = { dismissals++ }) }
    }
    onRoot().performTouchInput { click(Offset(1f, 1f)) }
    assertEquals(1, dismissals)
  }

  @Test
  fun `clicking dialog content does not dismiss`() = runComposeUiTest {
    var dismissals = 0
    setContent {
      MaterialTheme { AboutDialog(version = AppVersion.Dev, onDismiss = { dismissals++ }) }
    }
    onNodeWithText("AutoMobile").performClick()
    assertEquals(0, dismissals)
  }
}
