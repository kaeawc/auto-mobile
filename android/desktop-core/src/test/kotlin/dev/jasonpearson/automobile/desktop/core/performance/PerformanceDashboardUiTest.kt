package dev.jasonpearson.automobile.desktop.core.performance

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class PerformanceDashboardUiTest {

  @Test
  fun `shows fps metric when initial fps provided`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PerformanceDashboard(
            dataSourceMode = DataSourceMode.Fake,
            initialFps = 60f,
        )
      }
    }
    onNodeWithText("Frame Rate").assertIsDisplayed()
    onNodeWithText("60").assertIsDisplayed()
    onNodeWithText("fps").assertIsDisplayed()
  }

  @Test
  fun `shows memory metric when initial memory provided`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PerformanceDashboard(
            dataSourceMode = DataSourceMode.Fake,
            initialMemoryMb = 128f,
        )
      }
    }
    onNodeWithText("Memory Usage").assertIsDisplayed()
    onNodeWithText("128").assertIsDisplayed()
    onNodeWithText("MB").assertIsDisplayed()
  }

  @Test
  fun `shows multiple metrics when multiple initials provided`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PerformanceDashboard(
            dataSourceMode = DataSourceMode.Fake,
            initialFps = 58f,
            initialFrameTimeMs = 16f,
            initialJankFrames = 3,
            initialMemoryMb = 200f,
        )
      }
    }
    onNodeWithText("Frame Rate").assertIsDisplayed()
    onNodeWithText("Frame Time").assertIsDisplayed()
    onNodeWithText("Jank (Missed Frames)").assertIsDisplayed()
    onNodeWithText("Memory Usage").assertIsDisplayed()
  }

  @Test
  fun `shows touch latency metric`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PerformanceDashboard(
            dataSourceMode = DataSourceMode.Fake,
            initialFps = 60f,
            initialTouchLatencyMs = 42f,
        )
      }
    }
    onNodeWithText("Touch Latency").assertIsDisplayed()
    onNodeWithText("42").assertIsDisplayed()
  }

  @Test
  fun `shows recomposition metric`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        PerformanceDashboard(
            dataSourceMode = DataSourceMode.Fake,
            initialFps = 60f,
            initialRecompositionRate = 5f,
        )
      }
    }
    onNodeWithText("Recompositions").assertIsDisplayed()
    onNodeWithText("5").assertIsDisplayed()
  }
}
