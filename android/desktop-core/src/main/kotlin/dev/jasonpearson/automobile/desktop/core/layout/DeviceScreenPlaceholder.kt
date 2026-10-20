@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun DeviceScreenOptions.DeviceScreenPlaceholder() {
  val colors = SharedTheme.globalColors
  Box(
    modifier =
      Modifier.fillMaxSize()
        .background(Color(0xFF1A1A1A))
        .border(2.dp, Color(0xFF333333), RoundedCornerShape(8.dp)),
    contentAlignment = Alignment.Center,
  ) {
    when {
      hierarchyUnavailableReason != null -> {
        Text(
          "Hierarchy unavailable - $hierarchyUnavailableReason. Try getApple / reprovision.",
          color = colors.text.normal,
          fontSize = 12.sp,
        )
      }
      connectionStatus == ConnectionStatus.Disconnected && !socketExists -> {
        // Daemon is down - show restart button
        DaemonRestartPlaceholder()
      }
      connectionStatus == ConnectionStatus.Disconnected -> {
        // Socket exists but device gone
        Text(
          "Device Disconnected",
          color = colors.text.normal.copy(alpha = 0.5f),
          fontSize = 12.sp,
        )
      }
      connectionStatus == ConnectionStatus.Connecting -> {
        // Reconnecting state with spinner
        ReconnectingPlaceholder()
      }
      else -> {
        Text(
          "Awaiting Observation",
          color = colors.text.normal.copy(alpha = 0.5f),
          fontSize = 12.sp,
        )
      }
    }
  }
}

@Composable
internal fun DeviceScreenOptions.DaemonRestartPlaceholder() {
  val colors = SharedTheme.globalColors
  Column(
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Text(
      "Device Disconnected",
      color = colors.text.normal.copy(alpha = 0.5f),
      fontSize = 12.sp,
    )
    if (onRestartDaemon != null) {
      Box(
        modifier =
          Modifier.background(
              colors.text.normal.copy(alpha = 0.1f),
              RoundedCornerShape(4.dp),
            )
            .border(
              1.dp,
              colors.text.normal.copy(alpha = 0.2f),
              RoundedCornerShape(4.dp),
            )
            .clickable(onClick = onRestartDaemon)
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(horizontal = 12.dp, vertical = 6.dp),
      ) {
        Text(
          "Restart MCP Daemon",
          color = colors.text.normal.copy(alpha = 0.7f),
          fontSize = 11.sp,
        )
      }
    }
  }
}

@Composable
internal fun DeviceScreenOptions.ReconnectingPlaceholder() {
  val colors = SharedTheme.globalColors
  Column(
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text(
      "Device Disconnected",
      color = colors.text.normal.copy(alpha = 0.5f),
      fontSize = 12.sp,
    )
    ReconnectingSpinner()
    Text(
      "Reconnecting...",
      color = colors.text.normal.copy(alpha = 0.25f),
      fontSize = 10.sp,
    )
  }
}

/** Low-contrast reconnecting spinner with rotating dots. */
@Composable
internal fun ReconnectingSpinner() {
  val infiniteTransition = rememberInfiniteTransition(label = "reconnecting")
  val angle by
    infiniteTransition.animateFloat(
      initialValue = 0f,
      targetValue = 360f,
      animationSpec =
        infiniteRepeatable(
          animation = tween(durationMillis = 1200, easing = LinearEasing),
          repeatMode = RepeatMode.Restart,
        ),
      label = "rotation",
    )

  val colors = SharedTheme.globalColors
  val dotColor = colors.text.normal.copy(alpha = 0.2f)

  Canvas(modifier = Modifier.size(24.dp)) {
    val centerX = size.width / 2
    val centerY = size.height / 2
    val radius = size.width / 2 - 4.dp.toPx()
    val dotRadius = 2.dp.toPx()
    val dotCount = 8

    for (i in 0 until dotCount) {
      val dotAngle = Math.toRadians((angle + i * 360.0 / dotCount).toDouble())
      val alpha = 0.15f + 0.15f * (i.toFloat() / dotCount)
      val x = centerX + radius * kotlin.math.cos(dotAngle).toFloat()
      val y = centerY + radius * kotlin.math.sin(dotAngle).toFloat()
      drawCircle(
        color = dotColor.copy(alpha = alpha),
        radius = dotRadius,
        center = androidx.compose.ui.geometry.Offset(x, y),
      )
    }
  }
}
