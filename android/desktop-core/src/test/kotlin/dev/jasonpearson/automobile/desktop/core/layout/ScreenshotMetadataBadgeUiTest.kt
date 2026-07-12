package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class ScreenshotMetadataBadgeUiTest {

  @Test
  fun `shows fallback badge and reason when fallback is true`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ScreenshotMetadataOverlay(
          fallback = true,
          fallbackReason = "websocket_unavailable",
          format = null,
          captureSource = null,
        )
      }
    }
    onNodeWithText("Fallback capture").assertIsDisplayed()
    onNodeWithText("websocket_unavailable").assertIsDisplayed()
  }

  @Test
  fun `shows fallback badge without reason text when reason is absent`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ScreenshotMetadataOverlay(
          fallback = true,
          fallbackReason = null,
          format = null,
          captureSource = null,
        )
      }
    }
    onNodeWithText("Fallback capture").assertIsDisplayed()
  }

  @Test
  fun `hides fallback badge when fallback is false`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ScreenshotMetadataOverlay(
          fallback = false,
          fallbackReason = "websocket_unavailable",
          format = null,
          captureSource = null,
        )
      }
    }
    onNodeWithText("Fallback capture").assertDoesNotExist()
    // A stale reason from a previous fallback must not leak once fallback clears.
    onNodeWithText("websocket_unavailable").assertDoesNotExist()
  }

  @Test
  fun `shows combined format and capture source label`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ScreenshotMetadataOverlay(
          fallback = false,
          fallbackReason = null,
          format = "png",
          captureSource = "android_adb_screencap",
        )
      }
    }
    onNodeWithText("png · android_adb_screencap").assertIsDisplayed()
  }

  @Test
  fun `shows format only when capture source is absent`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ScreenshotMetadataOverlay(
          fallback = false,
          fallbackReason = null,
          format = "png",
          captureSource = null,
        )
      }
    }
    onNodeWithText("png").assertIsDisplayed()
  }

  @Test
  fun `renders nothing when no metadata is present`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        ScreenshotMetadataOverlay(
          fallback = false,
          fallbackReason = null,
          format = null,
          captureSource = null,
        )
      }
    }
    onNodeWithText("Fallback capture").assertDoesNotExist()
  }
}
