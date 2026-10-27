package dev.jasonpearson.automobile.desktop.core

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.PlatformIcons
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun BootedDeviceRow(
  device: dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo,
  isKilling: Boolean = false,
  killError: String? = null,
  isUpdatingService: Boolean = false,
  options: BootedDeviceActions,
) {
  return with(options) {
    val colors = SharedTheme.globalColors
    val isIos = device.platform.equals("ios", ignoreCase = true)
    val isPhysical = !device.isVirtual

    Column(
      modifier =
        Modifier.fillMaxWidth()
          .let { mod ->
            if (isPhysical) {
              mod.border(1.dp, Color(0xFFFFA726).copy(alpha = 0.5f), RoundedCornerShape(4.dp))
            } else {
              mod
            }
          }
          .background(Color(0xFF4CAF50).copy(alpha = 0.1f), RoundedCornerShape(4.dp))
          .padding(8.dp),
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Icon(
          imageVector = PlatformIcons.logo(isIos),
          contentDescription = PlatformIcons.contentDescription(isIos),
          tint = PlatformIcons.tint(isIos),
          modifier = Modifier.size(16.dp),
        )
        BootedDeviceIdentity(device, isPhysical)
        SelectDeviceButton(device)
        // Kill button
        KillDeviceButton(isKilling, killError)
      }

      // Kill error
      if (killError != null) {
        Text(
          killError,
          fontSize = 8.sp,
          color = Color(0xFFE53935),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }

      // Service status row
      val serviceStatus = device.runtime.serviceStatus
      DeviceServiceStatus(device, serviceStatus, isUpdatingService)
    }
  }
}

@Composable
internal fun androidx.compose.foundation.layout.RowScope.BootedDeviceIdentity(
  device: dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo,
  isPhysical: Boolean,
) {
  val colors = SharedTheme.globalColors
  Column(modifier = Modifier.weight(1f)) {
    Row(
      horizontalArrangement = Arrangement.spacedBy(4.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        device.name,
        fontSize = 11.sp,
        fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f, fill = false),
      )
      if (isPhysical) {
        Box(
          modifier =
            Modifier.background(
                Color(0xFFFFA726).copy(alpha = 0.2f),
                RoundedCornerShape(3.dp),
              )
              .padding(horizontal = 4.dp, vertical = 1.dp),
        ) {
          Text(
            "Physical",
            fontSize = 8.sp,
            maxLines = 1,
            softWrap = false,
            color = Color(0xFFFFA726),
          )
        }
      }
    }
    Text(
      device.runtime.deviceId ?: device.identity.stableId,
      fontSize = 9.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
internal fun BootedDeviceActions.SelectDeviceButton(
  device: dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo,
) {
  // Select button
  Box(
    modifier =
      Modifier.background(Color(0xFF4CAF50).copy(alpha = 0.2f), RoundedCornerShape(4.dp))
        .clickable(
          onClick = {
            LOG.debug(
              "[AutoMobile IDE] BootedDeviceRow Select clicked for: ${device.name}",
            )
            onSelect()
          },
        )
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 6.dp, vertical = 2.dp),
  ) {
    Text(
      "Select",
      fontSize = 9.sp,
      maxLines = 1,
      softWrap = false,
      color = Color(0xFF4CAF50),
    )
  }
}

@Composable
internal fun BootedDeviceActions.KillDeviceButton(isKilling: Boolean, killError: String?) {
  Box(
    modifier =
      Modifier.background(
          if (killError != null) Color(0xFFE53935).copy(alpha = 0.15f)
          else Color(0xFFE53935).copy(alpha = 0.1f),
          RoundedCornerShape(4.dp),
        )
        .clickable(enabled = !isKilling, onClick = onKill)
        .pointerHoverIcon(if (isKilling) PointerIcon.Default else PointerIcon.Hand)
        .padding(horizontal = 6.dp, vertical = 2.dp),
  ) {
    Text(
      when {
        isKilling -> "..."
        killError != null -> "Err"
        else -> "Kill"
      },
      fontSize = 9.sp,
      maxLines = 1,
      softWrap = false,
      color = Color(0xFFE53935),
    )
  }
}

@Composable
internal fun BootedDeviceActions.DeviceServiceStatus(
  device: dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo,
  serviceStatus: dev.jasonpearson.automobile.desktop.core.mcp.DeviceServiceStatus?,
  isUpdatingService: Boolean,
) {
  val colors = SharedTheme.globalColors
  if (serviceStatus != null) {
    Row(
      horizontalArrangement = Arrangement.spacedBy(6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      val statusOk = serviceStatus.isCompatible && serviceStatus.running
      val statusIcon = if (statusOk) "+" else "x"
      val statusColor = if (statusOk) Color(0xFF4CAF50) else Color(0xFFE53935)
      val serviceName = if (device.platform == "android") "A11y" else "XCTest"
      val statusLabel = if (statusOk) "$serviceName OK" else "$serviceName Mismatch"

      Text(statusIcon, fontSize = 9.sp, color = statusColor)
      Text(
        statusLabel,
        fontSize = 9.sp,
        color = statusColor,
        maxLines = 1,
      )
      val sha = serviceStatus.installedSha256
      if (sha != null && sha.isNotEmpty()) {
        Text(
          sha.take(8),
          fontSize = 8.sp,
          color = colors.text.normal.copy(alpha = 0.4f),
          maxLines = 1,
        )
      }
      if (!serviceStatus.isCompatible) {
        Box(
          modifier =
            Modifier.background(
                Color(0xFFFFA726).copy(alpha = 0.2f),
                RoundedCornerShape(3.dp),
              )
              .clickable(enabled = !isUpdatingService, onClick = onUpdateService)
              .pointerHoverIcon(
                if (isUpdatingService) PointerIcon.Default else PointerIcon.Hand,
              )
              .padding(horizontal = 4.dp, vertical = 1.dp),
        ) {
          Text(
            if (isUpdatingService) "..." else "Update",
            fontSize = 8.sp,
            maxLines = 1,
            softWrap = false,
            color = Color(0xFFFFA726),
          )
        }
      }
    }
  }
}

internal data class BootedDeviceActions(
  val onSelect: () -> Unit,
  val onKill: () -> Unit,
  val onUpdateService: () -> Unit,
)
