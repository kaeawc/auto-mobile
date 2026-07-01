package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class FailuresBadgeUiTest {

  @Test
  fun `shows zero count`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FailuresBadge(failureCount = 0, hasCritical = false)
      }
    }
    onNodeWithText("0").assertIsDisplayed()
  }

  @Test
  fun `shows single digit count`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FailuresBadge(failureCount = 5, hasCritical = false)
      }
    }
    onNodeWithText("5").assertIsDisplayed()
  }

  @Test
  fun `shows double digit count`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FailuresBadge(failureCount = 42, hasCritical = true)
      }
    }
    onNodeWithText("42").assertIsDisplayed()
  }

  @Test
  fun `shows 99+ for counts over 99`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FailuresBadge(failureCount = 100, hasCritical = false)
      }
    }
    onNodeWithText("99+").assertIsDisplayed()
  }

  @Test
  fun `shows 99+ for very large counts`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FailuresBadge(failureCount = 10000, hasCritical = true)
      }
    }
    onNodeWithText("99+").assertIsDisplayed()
  }

  @Test
  fun `shows exact count at boundary 99`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FailuresBadge(failureCount = 99, hasCritical = false)
      }
    }
    onNodeWithText("99").assertIsDisplayed()
  }
}
