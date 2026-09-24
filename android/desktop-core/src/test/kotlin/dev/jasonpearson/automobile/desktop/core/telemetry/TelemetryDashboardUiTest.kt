package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.FakeTelemetryPushClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import org.junit.Assert.assertEquals
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

  @Test
  fun `terminal telemetry error offers Retry for the active device`() = runComposeUiTest {
    val fake = FakeTelemetryPushClient()
    setContent {
      MaterialTheme {
        TelemetryDashboard(
          telemetryPushClient = fake,
          dataSourceMode = DataSourceMode.Real,
          activeDeviceId = "dev-1",
        )
      }
    }
    fake.setConnectionState(ConnectionState.Error("Telemetry unavailable on this daemon"))
    waitUntil(timeoutMillis = 2_000) {
      onAllNodesWithText("Retry").fetchSemanticsNodes().isNotEmpty()
    }
    onNodeWithText("Retry").assertIsDisplayed().performClick()
    assertEquals(1, fake.getConnectCallCount())
    assertEquals("dev-1", fake.getLastDeviceId())
  }
}
