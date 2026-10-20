package dev.jasonpearson.automobile.desktop.core

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun DevicesSection(
  onSelectDevice: (dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo) -> Unit,
  onBootDevice: (dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo) -> Unit,
  onKillDevice: (dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo) -> Unit,
  onUpdateService: (dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo) -> Unit,
  options: DevicesSectionState,
) {
  return with(options) {
    val colors = SharedTheme.globalColors

    Column(
      modifier =
        Modifier.fillMaxWidth()
          .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
          .padding(12.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      // Header
      DevicesHeader(isLoading)

      // Daemon status info
      if (daemonStatus != null) {
        DaemonStatusInfo(daemonStatus = daemonStatus)
      }

      if (daemonStatusError != null) {
        Text(
          daemonStatusError,
          fontSize = 10.sp,
          color = Color(0xFFE53935),
        )
      }

      if (error != null) {
        Text(
          error,
          fontSize = 10.sp,
          color = Color(0xFFE53935),
        )
      } else if (!isLoading) {
        // Running devices
        RunningDevices(onSelectDevice, onKillDevice, onUpdateService)

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
}

@Composable
private fun DaemonStatusInfo(
  daemonStatus: dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse,
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
          val api = image.apiLevel
          if (api != null) "API $api" else "Android (Unknown)"
        } else {
          extractIosVersion(image.osVersion) ?: "iOS (Unknown)"
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
          val deviceKey = image.identity.stableId
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

data class DevicesSectionState(
  val bootedDevices: List<dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo>,
  val deviceImages: List<dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo>,
  val isLoading: Boolean,
  val error: String?,
  val bootingDeviceIds: Set<String>,
  val killingDeviceIds: Set<String>,
  val bootErrors: Map<String, String>,
  val killErrors: Map<String, String>,
  val daemonStatus: dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse?,
  val updatingServiceDeviceIds: Set<String>,
  val daemonStatusError: String? = null,
)

@Composable
private fun DevicesHeader(isLoading: Boolean) {
  val colors = SharedTheme.globalColors
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
}

@Composable
private fun DevicesSectionState.RunningDevices(
  onSelectDevice: (dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo) -> Unit,
  onKillDevice: (dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo) -> Unit,
  onUpdateService: (dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo) -> Unit,
) {
  val colors = SharedTheme.globalColors
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
        val deviceId = device.runtime.deviceId ?: device.identity.stableId
        BootedDeviceRow(
          device = device,
          isKilling = deviceId in killingDeviceIds,
          killError = killErrors[deviceId],
          isUpdatingService = deviceId in updatingServiceDeviceIds,
          options =
            BootedDeviceActions(
              onSelect = { onSelectDevice(device) },
              onKill = { onKillDevice(device) },
              onUpdateService = { onUpdateService(device) },
            ),
        )
      }
    }
  }
}
