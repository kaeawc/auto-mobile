package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class TelemetryDashboardUiTest {

  @Test
  fun `shows empty state in real mode with no client`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TelemetryDashboard(
          telemetryPushClient = null,
          dataSourceMode = DataSourceMode.Real,
        )
      }
    }
    onNodeWithText("No telemetry events yet").assertIsDisplayed()
  }

  @Test
  fun `shows search bar placeholder`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TelemetryDashboard(
          telemetryPushClient = null,
          dataSourceMode = DataSourceMode.Real,
        )
      }
    }
    onNodeWithText("Filter events...").assertIsDisplayed()
  }

  @Test
  fun `renders without crashing with null client and active device`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TelemetryDashboard(
          telemetryPushClient = null,
          dataSourceMode = DataSourceMode.Real,
          activeDeviceId = "emulator-5554",
        )
      }
    }
    onNodeWithText("No telemetry events yet").assertIsDisplayed()
  }

  @Test
  fun `renders buffer counter`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        TelemetryDashboard(
          telemetryPushClient = null,
          dataSourceMode = DataSourceMode.Real,
        )
      }
    }
    onNodeWithText("0/1000").assertIsDisplayed()
  }
}
