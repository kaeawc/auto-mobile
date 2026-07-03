package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class FailuresCollapsedContentUiTest {

  @Test
  fun `shows date range label`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FailuresCollapsedContent(
          dateRangeLabel = "24h",
          crashCount = 0,
          anrCount = 0,
          toolFailureCount = 0,
          nonFatalCount = 0,
        )
      }
    }
    onNodeWithText("24h").assertIsDisplayed()
  }

  @Test
  fun `shows all zero counts`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FailuresCollapsedContent(
          dateRangeLabel = "7d",
          crashCount = 0,
          anrCount = 0,
          toolFailureCount = 0,
          nonFatalCount = 0,
        )
      }
    }
    onNodeWithText("7d").assertIsDisplayed()
    onNodeWithText(FailureType.Crash.icon).assertIsDisplayed()
    onNodeWithText(FailureType.ANR.icon).assertIsDisplayed()
    onNodeWithText(FailureType.ToolCallFailure.icon).assertIsDisplayed()
    onNodeWithText(FailureType.NonFatal.icon).assertIsDisplayed()
  }

  @Test
  fun `shows non-zero counts`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FailuresCollapsedContent(
          dateRangeLabel = "30d",
          crashCount = 12,
          anrCount = 3,
          toolFailureCount = 7,
          nonFatalCount = 25,
        )
      }
    }
    onNodeWithText("12").assertIsDisplayed()
    onNodeWithText("3").assertIsDisplayed()
    onNodeWithText("7").assertIsDisplayed()
    onNodeWithText("25").assertIsDisplayed()
  }

  @Test
  fun `shows compact number format for thousands`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FailuresCollapsedContent(
          dateRangeLabel = "30d",
          crashCount = 1500,
          anrCount = 200,
          toolFailureCount = 0,
          nonFatalCount = 10000,
        )
      }
    }
    onNodeWithText("1.5k").assertIsDisplayed()
    onNodeWithText("200").assertIsDisplayed()
    onNodeWithText("10k").assertIsDisplayed()
  }

  @Test
  fun `shows compact number format for millions`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FailuresCollapsedContent(
          dateRangeLabel = "30d",
          crashCount = 2500000,
          anrCount = 0,
          toolFailureCount = 0,
          nonFatalCount = 0,
        )
      }
    }
    onNodeWithText("2.5m").assertIsDisplayed()
  }
}
