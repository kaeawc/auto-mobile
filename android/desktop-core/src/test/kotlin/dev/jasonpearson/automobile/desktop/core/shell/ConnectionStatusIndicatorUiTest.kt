package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class ConnectionStatusIndicatorUiTest {

  @Test
  fun `shows label when connected`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ConnectionStatusIndicator(
            isConnected = true,
            label = "Connected",
        )
      }
    }
    onNodeWithText("Connected").assertIsDisplayed()
  }

  @Test
  fun `shows label when disconnected`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ConnectionStatusIndicator(
            isConnected = false,
            label = "Disconnected",
        )
      }
    }
    onNodeWithText("Disconnected").assertIsDisplayed()
  }

  @Test
  fun `shows label when reconnecting`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ConnectionStatusIndicator(
            isConnected = false,
            isReconnecting = true,
            label = "Reconnecting...",
        )
      }
    }
    onNodeWithText("Reconnecting...").assertIsDisplayed()
  }

  @Test
  fun `renders without label`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ConnectionStatusIndicator(
            isConnected = true,
            label = null,
        )
      }
    }
    // Just verifies the composable renders without crashing when no label is provided.
    // The dot is drawn via Box/background, not text, so there is nothing to assert via text.
  }
}
