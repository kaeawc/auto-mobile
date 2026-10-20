package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.formatUiNumber
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.delay

@Composable
internal fun StatusBarStub(options: ShellStatusOptions) {
  val connectionStartTime = options.connectionStartTime
  val colors = SharedTheme.globalColors

  // Elapsed session timer — ticks every second when connectionStartTime is set
  var elapsedSeconds by remember { mutableStateOf(0L) }
  LaunchedEffect(connectionStartTime) {
    if (connectionStartTime != null) {
      while (true) {
        elapsedSeconds = (System.currentTimeMillis() - connectionStartTime) / 1000L
        delay(1000L)
      }
    } else {
      elapsedSeconds = 0L
    }
  }

  Row(
    Modifier.fillMaxWidth()
      .height(24.dp)
      .background(colors.panelBackground)
      .padding(horizontal = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    StatusConnection(options, elapsedSeconds)
    StatusLoadMetrics(options)
    StatusFailureCount(options)
    StatusFrameMetrics(options)
  }
}

@Composable
internal fun androidx.compose.foundation.layout.RowScope.StatusConnection(
  options: ShellStatusOptions,
  elapsedSeconds: Long,
) {
  val crashCount = options.crashCount
  val anrCount = options.anrCount
  val nonFatalCount = options.nonFatalCount
  val toolFailureCount = options.toolFailureCount

  val isDaemonConnected = options.isDaemonConnected
  val deviceName = options.deviceName
  val foregroundApp = options.foregroundApp

  val connectionStartTime = options.connectionStartTime

  val colors = SharedTheme.globalColors
  val totalFailures = crashCount + anrCount + nonFatalCount + toolFailureCount

  // Connection indicator — clickable segment
  val connColor =
    if (isDaemonConnected) Color(0xFF4CAF50) else colors.text.normal.copy(alpha = 0.3f)
  Text(
    text = if (isDaemonConnected) "Connected" else "Disconnected",
    fontSize = 10.sp,
    color = connColor,
  )

  // Session timer
  if (connectionStartTime != null && isDaemonConnected) {
    Spacer(Modifier.width(8.dp))
    Text(
      text = formatElapsed(elapsedSeconds),
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
  }

  Spacer(Modifier.width(12.dp))

  // Device / app
  if (deviceName != null) {
    Text(
      text = deviceName + (foregroundApp?.let { " — $it" } ?: ""),
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
      maxLines = 1,
    )
  }

  Spacer(Modifier.weight(1f))
}

@Composable
internal fun androidx.compose.foundation.layout.RowScope.StatusLoadMetrics(
  options: ShellStatusOptions,
) {
  val crashCount = options.crashCount
  val anrCount = options.anrCount
  val nonFatalCount = options.nonFatalCount
  val toolFailureCount = options.toolFailureCount

  val networkReqPerSec = options.networkReqPerSec

  val cpuUsagePercent = options.cpuUsagePercent

  val colors = SharedTheme.globalColors
  val totalFailures = crashCount + anrCount + nonFatalCount + toolFailureCount

  // Network throughput
  networkReqPerSec?.let { rps ->
    Text(
      text = "${formatUiNumber("%.0f", rps)} req/s",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
    )
    Spacer(Modifier.width(12.dp))
  }

  // CPU usage — color-coded
  cpuUsagePercent?.let { cpu ->
    val cpuColor =
      when {
        cpu >= 80f -> colors.text.error
        cpu >= 50f -> colors.text.warning
        else -> Color(0xFF4CAF50)
      }
    Text(
      text = "CPU: ${formatUiNumber("%.0f", cpu)}%",
      fontSize = 10.sp,
      color = cpuColor,
    )
    Spacer(Modifier.width(12.dp))
  }
}

@Composable
internal fun androidx.compose.foundation.layout.RowScope.StatusFailureCount(
  options: ShellStatusOptions,
) {
  val crashCount = options.crashCount
  val anrCount = options.anrCount
  val nonFatalCount = options.nonFatalCount
  val toolFailureCount = options.toolFailureCount

  val colors = SharedTheme.globalColors
  val totalFailures = crashCount + anrCount + nonFatalCount + toolFailureCount

  // Failure counts
  if (totalFailures > 0) {
    Text(
      text = "Failures: $totalFailures",
      fontSize = 10.sp,
      color = if (crashCount > 0) colors.text.error else colors.text.warning,
    )
    Spacer(Modifier.width(12.dp))
  }
}

@Composable
internal fun androidx.compose.foundation.layout.RowScope.StatusFrameMetrics(
  options: ShellStatusOptions,
) {
  val crashCount = options.crashCount
  val anrCount = options.anrCount
  val nonFatalCount = options.nonFatalCount
  val toolFailureCount = options.toolFailureCount
  val currentFps = options.currentFps
  val currentMemoryMb = options.currentMemoryMb

  val colors = SharedTheme.globalColors
  val totalFailures = crashCount + anrCount + nonFatalCount + toolFailureCount

  // FPS
  currentFps?.let { fps ->
    Text(
      text = "FPS: ${fps.toInt()}",
      fontSize = 10.sp,
      color =
        when {
          fps >= 55f -> Color(0xFF4CAF50)
          fps >= 30f -> colors.text.warning
          else -> colors.text.error
        },
    )
    Spacer(Modifier.width(12.dp))
  }

  // Memory
  currentMemoryMb?.let { mem ->
    Text(
      text = "Mem: ${mem.toInt()} MB",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
    )
  }
}

internal data class ShellStatusOptions(
  val crashCount: Int,
  val anrCount: Int,
  val nonFatalCount: Int,
  val toolFailureCount: Int,
  val currentFps: Float?,
  val currentMemoryMb: Float?,
  val isDaemonConnected: Boolean,
  val deviceName: String?,
  val foregroundApp: String?,
  val networkReqPerSec: Float? = null,
  val connectionStartTime: Long? = null,
  val cpuUsagePercent: Float? = null,
)
