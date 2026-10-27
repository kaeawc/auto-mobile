package dev.jasonpearson.automobile.desktop.core.diagnostics

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.mcp.McpConnectionType
import dev.jasonpearson.automobile.desktop.core.mcp.McpProcess
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * Diagnostics dashboard showing system requirements, MCP daemon status, and connection health
 * information.
 */
@Composable
fun DiagnosticsDashboard(
  connectedMcpProcess: McpProcess?,
  dataSourceMode: DataSourceMode,
  modifier: Modifier = Modifier,
  ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
) {
  val colors = SharedTheme.globalColors

  // Run system checks off the UI thread and refresh every 30 seconds
  var systemChecks by remember { mutableStateOf(emptyList<DiagnosticCheck>()) }
  LaunchedEffect(Unit) {
    while (true) {
      systemChecks = withContext(ioDispatcher) { runSystemChecks() }
      delay(30_000)
    }
  }

  Column(
    modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    // System Requirements Section
    DiagnosticSection(title = "System Requirements") {
      systemChecks.forEach { check ->
        DiagnosticCheckRow(check)
      }
    }

    DaemonStatus(connectedMcpProcess, dataSourceMode)
    // Socket Connection Health Section
    SocketHealth(connectedMcpProcess)

    // Data Source Mode Section
    DiagnosticSection(title = "Data Source") {
      DiagnosticRow(
        label = "Mode",
        value =
          when (dataSourceMode) {
            DataSourceMode.Fake -> "Fake (Mock Data)"
            DataSourceMode.Real -> "Real (Live Device)"
          },
        status = DiagnosticStatus.Info,
      )
    }
  }
}

@Composable
private fun DiagnosticSection(
  title: String,
  content: @Composable () -> Unit,
) {
  val colors = SharedTheme.globalColors

  Column(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(8.dp))
        .padding(12.dp),
  ) {
    Text(
      title,
      fontSize = 13.sp,
      fontWeight = FontWeight.Medium,
      color = colors.text.normal.copy(alpha = 0.8f),
    )
    Spacer(Modifier.height(12.dp))
    content()
  }
}

@Composable
private fun DiagnosticRow(
  label: String,
  value: String,
  status: DiagnosticStatus,
  isMonospace: Boolean = false,
) {
  val colors = SharedTheme.globalColors

  Row(
    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      label,
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
      modifier = Modifier.width(120.dp),
    )
    StatusIndicator(status)
    Spacer(Modifier.width(8.dp))
    Text(
      value,
      fontSize = 11.sp,
      fontFamily = if (isMonospace) FontFamily.Monospace else FontFamily.Default,
      color = colors.text.normal.copy(alpha = 0.9f),
      maxLines = 1,
    )
  }
}

@Composable
private fun DiagnosticCheckRow(check: DiagnosticCheck) {
  val colors = SharedTheme.globalColors

  Row(
    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    StatusIndicator(check.status)
    Spacer(Modifier.width(8.dp))
    Column(modifier = Modifier.weight(1f)) {
      Text(
        check.name,
        fontSize = 11.sp,
        color = colors.text.normal.copy(alpha = 0.9f),
      )
      if (check.details != null) {
        Text(
          check.details,
          fontSize = 10.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
        )
      }
    }
  }
}

@Composable
private fun StatusIndicator(status: DiagnosticStatus) {
  val color =
    when (status) {
      DiagnosticStatus.Success -> Color(0xFF4CAF50)
      DiagnosticStatus.Warning -> Color(0xFFFF9800)
      DiagnosticStatus.Error -> Color(0xFFE53935)
      DiagnosticStatus.Info -> Color(0xFF2196F3)
    }

  Box(modifier = Modifier.size(8.dp).background(color, CircleShape))
}

@Composable
private fun DaemonStatus(connectedMcpProcess: McpProcess?, dataSourceMode: DataSourceMode) {
  val colors = SharedTheme.globalColors
  // MCP Daemon Status Section
  DiagnosticSection(title = "MCP Daemon") {
    if (connectedMcpProcess != null) {
      ConnectedDaemonStatus(connectedMcpProcess)
    } else {
      DiagnosticRow(
        label = "Status",
        value =
          if (dataSourceMode == DataSourceMode.Fake) "Not Required (Fake Mode)"
          else "Not Connected",
        status =
          if (dataSourceMode == DataSourceMode.Fake) DiagnosticStatus.Info
          else DiagnosticStatus.Warning,
      )
      if (dataSourceMode == DataSourceMode.Real) {
        Text(
          "Start the AutoMobile MCP server to connect.",
          fontSize = 11.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
          modifier = Modifier.padding(top = 8.dp),
        )
      }
    }
  }
}

@Composable
private fun SocketHealth(connectedMcpProcess: McpProcess?) {
  if (connectedMcpProcess?.connectionType == McpConnectionType.UnixSocket) {
    val socketPath = connectedMcpProcess.socketPath
    DiagnosticSection(title = "Unix Socket Health") {
      if (socketPath != null) {
        val socketFile = File(socketPath)
        DiagnosticRow(
          label = "Socket Exists",
          value = if (socketFile.exists()) "Yes" else "No",
          status = if (socketFile.exists()) DiagnosticStatus.Success else DiagnosticStatus.Error,
        )
        if (socketFile.exists()) {
          DiagnosticRow(
            label = "Readable",
            value = if (socketFile.canRead()) "Yes" else "No",
            status = if (socketFile.canRead()) DiagnosticStatus.Success else DiagnosticStatus.Error,
          )
          DiagnosticRow(
            label = "Writable",
            value = if (socketFile.canWrite()) "Yes" else "No",
            status =
              if (socketFile.canWrite()) DiagnosticStatus.Success else DiagnosticStatus.Error,
          )
        }
      } else {
        DiagnosticRow(
          label = "Socket Path",
          value = "Not configured",
          status = DiagnosticStatus.Warning,
        )
      }
    }
  }
}

@Composable
private fun ConnectedDaemonStatus(connectedMcpProcess: McpProcess) {
  DiagnosticRow(
    label = "Status",
    value = "Connected",
    status = DiagnosticStatus.Success,
  )
  DiagnosticRow(
    label = "Process Name",
    value = connectedMcpProcess.name,
    status = DiagnosticStatus.Info,
  )
  DiagnosticRow(
    label = "PID",
    value = connectedMcpProcess.pid.toString(),
    status = DiagnosticStatus.Info,
  )
  DiagnosticRow(
    label = "Connection Type",
    value =
      when (connectedMcpProcess.connectionType) {
        McpConnectionType.UnixSocket -> "Unix Socket"
        McpConnectionType.StreamableHttp -> "HTTP (Port ${connectedMcpProcess.port ?: "?"})"
        McpConnectionType.Stdio -> "Standard I/O"
      },
    status = DiagnosticStatus.Info,
  )
  connectedMcpProcess.socketPath?.let { path ->
    DiagnosticRow(
      label = "Socket Path",
      value = path,
      status = if (File(path).exists()) DiagnosticStatus.Success else DiagnosticStatus.Warning,
      isMonospace = true,
    )
  }
}
