package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.video.VideoStreamQuality
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class StreamQualityControlsTest {

  @Test
  fun `collapsed shows the preset and frame rate but no selector`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        StreamQualityControls(
          currentQuality = VideoStreamQuality.Medium,
          actualFps = 23.6f,
          targetFps = 30,
          autoAdjustEnabled = true,
          expanded = false,
          onToggleExpanded = {},
          onSelectQuality = {},
          onToggleAutoAdjust = {},
        )
      }
    }
    // Readout: current preset + rounded actual over target. Selector chips are hidden until
    // expanded.
    onNodeWithText("Medium · 24 / 30 fps").assertIsDisplayed()
    onAllNodesWithText("Low").assertCountEquals(0)
    onAllNodesWithText("Auto").assertCountEquals(0)
  }

  @Test
  fun `tapping the readout toggles the selector open`() = runComposeUiTest {
    var toggled = 0
    setContent {
      MaterialTheme {
        StreamQualityControls(
          currentQuality = VideoStreamQuality.Medium,
          actualFps = 30f,
          targetFps = 30,
          autoAdjustEnabled = true,
          expanded = false,
          onToggleExpanded = { toggled++ },
          onSelectQuality = {},
          onToggleAutoAdjust = {},
        )
      }
    }
    onNodeWithText("Medium · 30 / 30 fps").performClick()
    assertEquals(1, toggled)
  }

  @Test
  fun `expanded offers every preset and reports the manual choice`() = runComposeUiTest {
    var selected: VideoStreamQuality? = null
    setContent {
      MaterialTheme {
        StreamQualityControls(
          currentQuality = VideoStreamQuality.Medium,
          actualFps = 30f,
          targetFps = 30,
          autoAdjustEnabled = true,
          expanded = true,
          onToggleExpanded = {},
          onSelectQuality = { selected = it },
          onToggleAutoAdjust = {},
        )
      }
    }
    onNodeWithText("Low").assertIsDisplayed()
    onNodeWithText("High").assertIsDisplayed()
    onNodeWithText("High").performClick()
    assertEquals(VideoStreamQuality.High, selected)
  }

  @Test
  fun `expanded toggles automatic adjustment`() = runComposeUiTest {
    var toggledTo: Boolean? = null
    setContent {
      MaterialTheme {
        StreamQualityControls(
          currentQuality = VideoStreamQuality.Low,
          actualFps = 10f,
          targetFps = 30,
          autoAdjustEnabled = true,
          expanded = true,
          onToggleExpanded = {},
          onSelectQuality = {},
          onToggleAutoAdjust = { toggledTo = it },
        )
      }
    }
    onNodeWithText("Auto").performClick()
    assertEquals(false, toggledTo)
  }
}
