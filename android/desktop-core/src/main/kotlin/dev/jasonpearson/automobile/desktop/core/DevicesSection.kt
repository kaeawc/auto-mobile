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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
internal fun DevicesSection(
  bootedDevices: List<dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo>,
  deviceImages: List<dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo>,
  isLoading: Boolean,
  error: String?,
  bootingDeviceIds: Set<String>,
  killingDeviceIds: Set<String>,
  bootErrors: Map<String, String>,
  killErrors: Map<String, String>,
  daemonStatus: dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse?,
  updatingServiceDeviceIds: Set<String>,
  onSelectDevice: (dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo) -> Unit,
  onBootDevice: (dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo) -> Unit,
  onKillDevice: (dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo) -> Unit,
  onUpdateService: (dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo) -> Unit,
) {
  val colors = SharedTheme.globalColors

  Column(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
        .padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    // Header
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        "Devices",
        fontSize = 12.sp,
        maxLines = 1,
        softWrap = false,
        fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
        color = colors.text.normal,
      )
      if (isLoading) {
        Text(
          "Loading...",
          fontSize = 10.sp,
          maxLines = 1,
          softWrap = false,
          color = Color(0xFF2196F3),
        )
      }
    }

    // Daemon status info
    if (daemonStatus != null) {
      DaemonStatusInfo(daemonStatus = daemonStatus)
    }

    if (error != null) {
      Text(
        error,
        fontSize = 10.sp,
        color = Color(0xFFE53935),
      )
    } else if (!isLoading) {
      // Running devices
      if (bootedDevices.isNotEmpty()) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Text(
            "Running (${bootedDevices.size})",
            fontSize = 10.sp,
            maxLines = 1,
            softWrap = false,
            color = colors.text.normal.copy(alpha = 0.6f),
          )
          bootedDevices.forEach { device ->
            BootedDeviceRow(
              device = device,
              isKilling = device.deviceId in killingDeviceIds,
              killError = killErrors[device.deviceId],
              isUpdatingService = device.deviceId in updatingServiceDeviceIds,
              onSelect = { onSelectDevice(device) },
              onKill = { onKillDevice(device) },
              onUpdateService = { onUpdateService(device) },
            )
          }
        }
      }

      // Available images grouped by API level
      if (deviceImages.isNotEmpty()) {
        DeviceImagesGrouped(
          deviceImages = deviceImages,
          bootingDeviceIds = bootingDeviceIds,
          bootErrors = bootErrors,
          onBootDevice = onBootDevice,
        )
      }

      if (bootedDevices.isEmpty() && deviceImages.isEmpty()) {
        Text(
          "No devices found",
          fontSize = 10.sp,
          maxLines = 1,
          softWrap = false,
          color = colors.text.normal.copy(alpha = 0.5f),
        )
      }
    }
  }
}

@Composable
private fun DaemonStatusInfo(
  daemonStatus: dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse
) {
  val colors = SharedTheme.globalColors
  Column(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.04f), RoundedCornerShape(4.dp))
        .padding(8.dp),
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    Row(
      horizontalArrangement = Arrangement.spacedBy(8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        "AutoMobile ${daemonStatus.version}",
        fontSize = 9.sp,
        fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
        color = colors.text.normal.copy(alpha = 0.7f),
        maxLines = 1,
      )
      if (daemonStatus.releaseVersion.isNotEmpty()) {
        Text(
          "(${daemonStatus.releaseVersion})",
          fontSize = 9.sp,
          color = colors.text.normal.copy(alpha = 0.4f),
          maxLines = 1,
        )
      }
    }
    val ctrlProxySha = daemonStatus.android?.ctrlProxy?.expectedSha256 ?: ""
    if (ctrlProxySha.isNotEmpty()) {
      Text(
        "CtrlProxy SHA: ${ctrlProxySha.take(8)}...",
        fontSize = 8.sp,
        color = colors.text.normal.copy(alpha = 0.4f),
        maxLines = 1,
      )
    }
    val xcTestSha = daemonStatus.ios?.xcTestService?.expectedSha256 ?: ""
    if (xcTestSha.isNotEmpty()) {
      Text(
        "XCTest SHA: ${xcTestSha.take(8)}...",
        fontSize = 8.sp,
        color = colors.text.normal.copy(alpha = 0.4f),
        maxLines = 1,
      )
    }
  }
}

internal fun extractApiLevel(target: String?): Int? {
  if (target == null) return null
  val match = Regex("""android-(\d+)""").find(target)
  return match?.groupValues?.get(1)?.toIntOrNull()
}

private fun extractIosVersion(iosVersion: String?): String? {
  if (iosVersion == null) return null
  val major = iosVersion.split(".").firstOrNull() ?: return null
  return "iOS $major"
}

private data class DeviceGroup(
  val label: String,
  val sortKey: Int,
  val images: List<dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo>,
)

@Composable
private fun DeviceImagesGrouped(
  deviceImages: List<dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo>,
  bootingDeviceIds: Set<String>,
  bootErrors: Map<String, String>,
  onBootDevice: (dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo) -> Unit,
) {
  val colors = SharedTheme.globalColors

  // Group images by API level / iOS version
  val groups =
    deviceImages
      .groupBy { image ->
        if (image.platform == "android") {
          val api = extractApiLevel(image.target)
          if (api != null) "API $api" else "Android (Unknown)"
        } else {
          extractIosVersion(image.iosVersion) ?: "iOS (Unknown)"
        }
      }
      .map { (label, images) ->
        val sortKey =
          when {
            label.startsWith("API ") -> label.removePrefix("API ").toIntOrNull() ?: 0
            label.startsWith("iOS ") -> label.removePrefix("iOS ").toIntOrNull() ?: 0
            else -> -1
          }
        DeviceGroup(label, sortKey, images)
      }
      .sortedByDescending { it.sortKey }

  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Text(
      "Available to Boot (${deviceImages.size})",
      fontSize = 10.sp,
      maxLines = 1,
      softWrap = false,
      color = colors.text.normal.copy(alpha = 0.6f),
    )
    groups.forEach { group ->
      CollapsibleDeviceGroup(
        group = group,
        bootingDeviceIds = bootingDeviceIds,
        bootErrors = bootErrors,
        onBootDevice = onBootDevice,
      )
    }
  }
}

@Composable
private fun CollapsibleDeviceGroup(
  group: DeviceGroup,
  bootingDeviceIds: Set<String>,
  bootErrors: Map<String, String>,
  onBootDevice: (dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo) -> Unit,
) {
  val colors = SharedTheme.globalColors
  var expanded by remember { mutableStateOf(false) }
  val deviceCount = group.images.size
  val deviceLabel = if (group.label.startsWith("iOS")) "simulator" else "device"
  val countSuffix = if (deviceCount == 1) deviceLabel else "${deviceLabel}s"

  Column {
    // Collapsible header
    Row(
      modifier =
        Modifier.fillMaxWidth()
          .clickable { expanded = !expanded }
          .pointerHoverIcon(PointerIcon.Hand)
          .padding(vertical = 2.dp),
      horizontalArrangement = Arrangement.spacedBy(4.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        if (expanded) "v" else ">",
        fontSize = 9.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
      Text(
        "${group.label} ($deviceCount $countSuffix)",
        fontSize = 10.sp,
        fontWeight = androidx.compose.ui.text.font.FontWeight.Medium,
        color = colors.text.normal.copy(alpha = 0.7f),
        maxLines = 1,
      )
    }

    if (expanded) {
      Column(
        modifier = Modifier.padding(start = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        group.images.forEach { image ->
          val deviceKey = image.deviceId ?: image.name
          DeviceImageRow(
            image = image,
            isBooting = deviceKey in bootingDeviceIds,
            error = bootErrors[deviceKey],
            onBoot = { onBootDevice(image) },
          )
        }
      }
    }
  }
}

@Composable
private fun BootedDeviceRow(
  device: dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo,
  isKilling: Boolean = false,
  killError: String? = null,
  isUpdatingService: Boolean = false,
  onSelect: () -> Unit,
  onKill: () -> Unit,
  onUpdateService: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  val isIos = device.platform != "android"
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
        contentDescription = null,
        tint = PlatformIcons.tint(isIos),
        modifier = Modifier.size(16.dp),
      )
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
                  .padding(horizontal = 4.dp, vertical = 1.dp)
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
          device.deviceId,
          fontSize = 9.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
      // Select button
      Box(
        modifier =
          Modifier.background(Color(0xFF4CAF50).copy(alpha = 0.2f), RoundedCornerShape(4.dp))
            .clickable(
              onClick = {
                LOG.debug("[AutoMobile IDE] BootedDeviceRow Select clicked for: ${device.name}")
                onSelect()
              }
            )
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(horizontal = 6.dp, vertical = 2.dp)
      ) {
        Text(
          "Select",
          fontSize = 9.sp,
          maxLines = 1,
          softWrap = false,
          color = Color(0xFF4CAF50),
        )
      }
      // Kill button
      Box(
        modifier =
          Modifier.background(
              if (killError != null) Color(0xFFE53935).copy(alpha = 0.15f)
              else Color(0xFFE53935).copy(alpha = 0.1f),
              RoundedCornerShape(4.dp),
            )
            .clickable(enabled = !isKilling, onClick = onKill)
            .pointerHoverIcon(if (isKilling) PointerIcon.Default else PointerIcon.Hand)
            .padding(horizontal = 6.dp, vertical = 2.dp)
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
    val serviceStatus = device.serviceStatus
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
                .pointerHoverIcon(if (isUpdatingService) PointerIcon.Default else PointerIcon.Hand)
                .padding(horizontal = 4.dp, vertical = 1.dp)
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
}

@Composable
private fun DeviceImageRow(
  image: dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo,
  isBooting: Boolean = false,
  error: String? = null,
  onBoot: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  val isIos = image.platform != "android"

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
        .clickable(enabled = !isBooting, onClick = onBoot)
        .pointerHoverIcon(if (isBooting) PointerIcon.Default else PointerIcon.Hand)
        .padding(8.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(
      imageVector = PlatformIcons.logo(isIos),
      contentDescription = null,
      tint = PlatformIcons.tint(isIos),
      modifier = Modifier.size(16.dp),
    )
    Column(modifier = Modifier.weight(1f)) {
      Text(
        image.name,
        fontSize = 11.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      if (error != null) {
        Text(
          error,
          fontSize = 9.sp,
          color = Color(0xFFE53935),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      } else {
        image.target?.let { target ->
          Text(
            target,
            fontSize = 9.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
        }
      }
    }
    Box(
      modifier =
        Modifier.background(
            when {
              error != null -> Color(0xFFE53935).copy(alpha = 0.15f)
              isBooting -> Color(0xFF2196F3).copy(alpha = 0.25f)
              else -> Color(0xFF2196F3).copy(alpha = 0.15f)
            },
            RoundedCornerShape(4.dp),
          )
          .padding(horizontal = 6.dp, vertical = 2.dp)
    ) {
      Text(
        when {
          error != null -> "Error"
          isBooting -> "..."
          else -> "Boot"
        },
        fontSize = 9.sp,
        maxLines = 1,
        softWrap = false,
        color =
          when {
            error != null -> Color(0xFFE53935)
            else -> Color(0xFF2196F3)
          },
      )
    }
  }
}
