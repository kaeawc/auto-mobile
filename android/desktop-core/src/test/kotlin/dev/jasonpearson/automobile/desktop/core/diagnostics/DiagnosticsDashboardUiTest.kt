package dev.jasonpearson.automobile.desktop.core.diagnostics

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.mcp.McpConnectionType
import dev.jasonpearson.automobile.desktop.core.mcp.McpProcess
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class DiagnosticsDashboardUiTest {

  @Test
  fun `shows section titles`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DiagnosticsDashboard(
            connectedMcpProcess = null,
            dataSourceMode = DataSourceMode.Fake,
        )
      }
    }
    onNodeWithText("System Requirements").assertIsDisplayed()
    onNodeWithText("MCP Daemon").assertIsDisplayed()
    onNodeWithText("Data Source").assertIsDisplayed()
  }

  @Test
  fun `shows not required in fake mode when no process`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DiagnosticsDashboard(
            connectedMcpProcess = null,
            dataSourceMode = DataSourceMode.Fake,
        )
      }
    }
    onNodeWithText("Not Required (Fake Mode)").assertIsDisplayed()
  }

  @Test
  fun `shows not connected in real mode when no process`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DiagnosticsDashboard(
            connectedMcpProcess = null,
            dataSourceMode = DataSourceMode.Real,
        )
      }
    }
    onNodeWithText("Not Connected").assertIsDisplayed()
    onNodeWithText("Start the AutoMobile MCP server to connect.").assertIsDisplayed()
  }

  @Test
  fun `shows connected status with process info`() = runComposeUiTest {
    val process =
        McpProcess(
            pid = 12345,
            name = "auto-mobile-daemon",
            connectionType = McpConnectionType.StreamableHttp,
            port = 3000,
        )
    setContent {
      MaterialTheme {
        DiagnosticsDashboard(
            connectedMcpProcess = process,
            dataSourceMode = DataSourceMode.Real,
        )
      }
    }
    onNodeWithText("Connected").assertIsDisplayed()
    onNodeWithText("auto-mobile-daemon").assertIsDisplayed()
    onNodeWithText("12345").assertIsDisplayed()
  }

  @Test
  fun `shows http connection type with port`() = runComposeUiTest {
    val process =
        McpProcess(
            pid = 100,
            name = "daemon",
            connectionType = McpConnectionType.StreamableHttp,
            port = 8080,
        )
    setContent {
      MaterialTheme {
        DiagnosticsDashboard(
            connectedMcpProcess = process,
            dataSourceMode = DataSourceMode.Real,
        )
      }
    }
    onNodeWithText("HTTP (Port 8080)").assertIsDisplayed()
  }

  @Test
  fun `shows fake data source mode`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DiagnosticsDashboard(
            connectedMcpProcess = null,
            dataSourceMode = DataSourceMode.Fake,
        )
      }
    }
    onNodeWithText("Fake (Mock Data)").assertIsDisplayed()
  }

  @Test
  fun `shows real data source mode`() = runComposeUiTest {
    setContent {
      MaterialTheme {
        DiagnosticsDashboard(
            connectedMcpProcess = null,
            dataSourceMode = DataSourceMode.Real,
        )
      }
    }
    onNodeWithText("Real (Live Device)").assertIsDisplayed()
  }

  @Test
  fun `shows stdio connection type`() = runComposeUiTest {
    val process =
        McpProcess(
            pid = 200,
            name = "mcp-stdio",
            connectionType = McpConnectionType.Stdio,
        )
    setContent {
      MaterialTheme {
        DiagnosticsDashboard(
            connectedMcpProcess = process,
            dataSourceMode = DataSourceMode.Real,
        )
      }
    }
    onNodeWithText("Standard I/O").assertIsDisplayed()
  }
}
