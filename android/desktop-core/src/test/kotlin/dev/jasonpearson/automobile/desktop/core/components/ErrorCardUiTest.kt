package dev.jasonpearson.automobile.desktop.core.components

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class ErrorCardUiTest {

  @Test
  fun `displays title and message`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ErrorCard(title = "Something went wrong", message = "Please try again later")
      }
    }
    onNodeWithText("Something went wrong").assertIsDisplayed()
    onNodeWithText("Please try again later").assertIsDisplayed()
  }

  @Test
  fun `shows retry button when onRetry provided`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ErrorCard(
          title = "Error",
          message = "Failed to load",
          onRetry = {},
        )
      }
    }
    onNodeWithText("Retry").assertIsDisplayed()
  }

  @Test
  fun `shows dismiss button when onDismiss provided`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ErrorCard(
          title = "Error",
          message = "Failed to load",
          onDismiss = {},
        )
      }
    }
    onNodeWithText("Dismiss").assertIsDisplayed()
  }

  @Test
  fun `no buttons when neither callback provided`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ErrorCard(title = "Error", message = "Something broke")
      }
    }
    onNodeWithText("Retry").assertDoesNotExist()
    onNodeWithText("Dismiss").assertDoesNotExist()
  }
}
