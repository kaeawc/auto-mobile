package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamQuality
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class StreamQualityControlsTest {

  @Test
  fun `shows the actual and target frame rate`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StreamQualityControls(
          currentQuality = VideoStreamQuality.Medium,
          actualFps = 23.6f,
          targetFps = 30,
          autoAdjustEnabled = true,
          onSelectQuality = {},
          onToggleAutoAdjust = {},
        )
      }
    }
    // Actual fps is rounded; target is the pane's requested rate.
    onNodeWithText("24 / 30 fps").assertIsDisplayed()
  }

  @Test
  fun `offers every quality preset and reports the manual choice`() = runComposeUiTest {
    var selected: VideoStreamQuality? = null
    setContent {
      MaterialTheme {
        StreamQualityControls(
          currentQuality = VideoStreamQuality.Medium,
          actualFps = 30f,
          targetFps = 30,
          autoAdjustEnabled = true,
          onSelectQuality = { selected = it },
          onToggleAutoAdjust = {},
        )
      }
    }
    onNodeWithText("Low").assertIsDisplayed()
    onNodeWithText("Medium").assertIsDisplayed()
    onNodeWithText("High").assertIsDisplayed()
    onNodeWithText("High").performClick()
    assertEquals(VideoStreamQuality.High, selected)
  }

  @Test
  fun `toggles automatic adjustment`() = runComposeUiTest {
    var toggledTo: Boolean? = null
    setContent {
      MaterialTheme {
        StreamQualityControls(
          currentQuality = VideoStreamQuality.Low,
          actualFps = 10f,
          targetFps = 30,
          autoAdjustEnabled = true,
          onSelectQuality = {},
          onToggleAutoAdjust = { toggledTo = it },
        )
      }
    }
    onNodeWithText("Auto").performClick()
    assertEquals(false, toggledTo)
  }
}
