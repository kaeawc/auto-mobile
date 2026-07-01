package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class StatusBarBadgeUiTest {

  @Test
  fun `shows count and label when count is positive`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StatusBarBadge(count = 5, label = "Crashes", color = Color.Red)
      }
    }
    onNodeWithText("5").assertIsDisplayed()
    onNodeWithText("Crashes").assertIsDisplayed()
  }

  @Test
  fun `does not render when count is zero`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StatusBarBadge(count = 0, label = "Crashes", color = Color.Red)
      }
    }
    onNodeWithText("Crashes").assertDoesNotExist()
    onNodeWithText("0").assertDoesNotExist()
  }

  @Test
  fun `does not render when count is negative`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StatusBarBadge(count = -1, label = "Errors", color = Color.Red)
      }
    }
    onNodeWithText("Errors").assertDoesNotExist()
  }

  @Test
  fun `shows large count`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StatusBarBadge(count = 999, label = "ANRs", color = Color(0xFFFF9800))
      }
    }
    onNodeWithText("999").assertIsDisplayed()
    onNodeWithText("ANRs").assertIsDisplayed()
  }
}
