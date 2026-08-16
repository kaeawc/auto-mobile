package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class FailuresFacetTest {

  private fun column(platform: Platform) =
    DeviceColumn(deviceId = "dev-1", name = "Pixel", platform = platform)

  /** The dashboard chrome renders for an Android pane (Fake mode avoids real MCP I/O). */
  @Test
  fun `renders the failures dashboard for an android pane`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FailuresFacet(column = column(Platform.Android), dataSourceMode = DataSourceMode.Fake)
      }
    }
    waitForIdle()
    // The Issues header and the All filter chip are the stable dashboard chrome.
    onNodeWithText("Issues", substring = true).assertIsDisplayed()
    onNodeWithText("All").assertIsDisplayed()
  }

  /**
   * The same cross-device dashboard renders for an iOS pane — failures are a global aggregate, so
   * the facet does not crash or diverge by platform.
   */
  @Test
  fun `renders the failures dashboard for an ios pane`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        FailuresFacet(column = column(Platform.Ios), dataSourceMode = DataSourceMode.Fake)
      }
    }
    waitForIdle()
    onNodeWithText("Issues", substring = true).assertIsDisplayed()
  }
}
