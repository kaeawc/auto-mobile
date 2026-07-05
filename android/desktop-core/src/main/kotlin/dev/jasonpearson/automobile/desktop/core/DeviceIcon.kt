package dev.jasonpearson.automobile.desktop.core

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.components.Tooltip
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDevice
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceType
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun DeviceIcon(
  device: BootedDevice,
  isActive: Boolean,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  val bgColor =
    if (isActive) colors.text.normal.copy(alpha = 0.15f) else colors.text.normal.copy(alpha = 0.05f)
  val borderColor = if (isActive) colors.text.normal.copy(alpha = 0.4f) else Color.Transparent
  val iconColor = if (isActive) colors.text.normal else colors.text.normal.copy(alpha = 0.4f)

  Tooltip(
    tooltip = {
      Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(device.name, fontSize = 12.sp)
        Text(
          "Status: ${device.status}",
          fontSize = 11.sp,
          color = colors.text.normal.copy(alpha = 0.7f),
        )
        device.foregroundApp?.let { app ->
          Text(
            "App: $app",
            fontSize = 11.sp,
            color = colors.text.normal.copy(alpha = 0.7f),
          )
        }
      }
    }
  ) {
    Box(
      modifier =
        Modifier.size(28.dp)
          .background(bgColor, shape = RoundedCornerShape(6.dp))
          .then(
            if (borderColor != Color.Transparent)
              Modifier.border(1.5.dp, borderColor, RoundedCornerShape(6.dp))
            else Modifier
          )
          .clickable(onClick = onClick)
          .pointerHoverIcon(PointerIcon.Hand),
      contentAlignment = Alignment.Center,
    ) {
      // Simple device icon representation
      when (device.type) {
        DeviceType.AndroidEmulator,
        DeviceType.AndroidPhysical -> AndroidDeviceIcon(color = iconColor)
        DeviceType.iOSSimulator,
        DeviceType.iOSPhysical -> AppleDeviceIcon(color = iconColor)
      }
    }
  }
}

@Composable
private fun AndroidDeviceIcon(color: Color) {
  // Simple Android robot head shape
  Box(modifier = Modifier.size(16.dp)) {
    // Body (rounded rectangle)
    Box(
      modifier =
        Modifier.align(Alignment.BottomCenter)
          .size(width = 12.dp, height = 10.dp)
          .background(
            color,
            RoundedCornerShape(
              topStart = 2.dp,
              topEnd = 2.dp,
              bottomStart = 3.dp,
              bottomEnd = 3.dp,
            ),
          )
    )
    // Head (smaller rounded rect on top)
    Box(
      modifier =
        Modifier.align(Alignment.TopCenter)
          .offset(y = 1.dp)
          .size(width = 10.dp, height = 5.dp)
          .background(color, RoundedCornerShape(topStart = 3.dp, topEnd = 3.dp))
    )
  }
}

@Composable
private fun AppleDeviceIcon(color: Color) {
  // Simple iPhone shape (rounded rectangle with notch hint)
  Box(
    modifier =
      Modifier.size(width = 10.dp, height = 16.dp).background(color, RoundedCornerShape(2.dp))
  )
}
