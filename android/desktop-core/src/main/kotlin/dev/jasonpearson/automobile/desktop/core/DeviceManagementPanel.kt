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
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.mcp.AvailableEmulator
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDevice
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceType
import dev.jasonpearson.automobile.desktop.core.mcp.SystemImage
import dev.jasonpearson.automobile.desktop.core.theme.PlatformIcons
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
private fun DeviceManagementPanel(
  bootedDevices: List<BootedDevice>,
  availableEmulators: List<AvailableEmulator>,
  systemImages: List<SystemImage>,
  onDeviceSelected: (String) -> Unit,
  onBootEmulator: (String) -> Unit,
  onCreateEmulator: (String) -> Unit,
) {
  val colors = SharedTheme.globalColors

  // Split devices by platform
  val androidDevices =
    bootedDevices
      .filter { it.type == DeviceType.AndroidEmulator || it.type == DeviceType.AndroidPhysical }
      .sortedByDescending { it.connectedAt }

  val iosDevices =
    bootedDevices
      .filter { it.type == DeviceType.iOSSimulator || it.type == DeviceType.iOSPhysical }
      .sortedByDescending { it.connectedAt }

  val androidEmulators = availableEmulators.filter { it.type == DeviceType.AndroidEmulator }
  val iosSimulators = availableEmulators.filter { it.type == DeviceType.iOSSimulator }

  val androidImages = systemImages.filter { it.platform == "Android" }
  val iosImages = systemImages.filter { it.platform == "iOS" }

  Column(
    modifier =
      Modifier.fillMaxWidth().background(colors.text.normal.copy(alpha = 0.02f)).padding(8.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    // Active Devices section
    if (androidDevices.isNotEmpty() || iosDevices.isNotEmpty()) {
      DeviceSectionHeader("Active Devices")
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
      ) {
        // Android column
        Column(
          modifier = Modifier.weight(1f),
          verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          Text("Android", fontSize = 10.sp, color = colors.text.normal.copy(alpha = 0.5f))
          if (androidDevices.isEmpty()) {
            Text("None", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.3f))
          } else {
            androidDevices.forEach { device ->
              DeviceListItem(
                name = device.name,
                status = device.status,
                icon = if (device.type == DeviceType.AndroidPhysical) "📱" else "📲",
                onClick = { onDeviceSelected(device.id) },
              )
            }
          }
        }

        // iOS column
        Column(
          modifier = Modifier.weight(1f),
          verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          Text("iOS", fontSize = 10.sp, color = colors.text.normal.copy(alpha = 0.5f))
          if (iosDevices.isEmpty()) {
            Text("None", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.3f))
          } else {
            iosDevices.forEach { device ->
              DeviceListItem(
                name = device.name,
                status = device.status,
                icon = if (device.type == DeviceType.iOSPhysical) "📱" else "📲",
                onClick = { onDeviceSelected(device.id) },
              )
            }
          }
        }
      }
    }

    // Available Emulators/Simulators section
    if (androidEmulators.isNotEmpty() || iosSimulators.isNotEmpty()) {
      DeviceSectionHeader("Available to Boot")
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
      ) {
        // Android emulators
        Column(
          modifier = Modifier.weight(1f),
          verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          if (androidEmulators.isNotEmpty()) {
            androidEmulators.forEach { emulator ->
              EmulatorListItem(
                name = emulator.name,
                apiLevel = emulator.apiLevel,
                isIos = false,
                onClick = { onBootEmulator(emulator.id) },
              )
            }
          }
        }

        // iOS simulators
        Column(
          modifier = Modifier.weight(1f),
          verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          if (iosSimulators.isNotEmpty()) {
            iosSimulators.forEach { simulator ->
              EmulatorListItem(
                name = simulator.name,
                apiLevel = null,
                isIos = true,
                onClick = { onBootEmulator(simulator.id) },
              )
            }
          }
        }
      }
    }

    // System Images section
    if (androidImages.isNotEmpty() || iosImages.isNotEmpty()) {
      DeviceSectionHeader("System Images")
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
      ) {
        // Android images
        Column(
          modifier = Modifier.weight(1f),
          verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          if (androidImages.isNotEmpty()) {
            androidImages.forEach { image ->
              SystemImageListItem(
                name = image.name,
                apiLevel = image.apiLevel,
                icon = "💿",
                onClick = { onCreateEmulator(image.id) },
              )
            }
          }
        }

        // iOS images
        Column(
          modifier = Modifier.weight(1f),
          verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          if (iosImages.isNotEmpty()) {
            iosImages.forEach { image ->
              SystemImageListItem(
                name = image.name,
                apiLevel = image.apiLevel,
                icon = "💿",
                onClick = { onCreateEmulator(image.id) },
              )
            }
          }
        }
      }
    }
  }
}

@Composable
private fun DeviceSectionHeader(title: String) {
  val colors = SharedTheme.globalColors
  Text(
    title,
    fontSize = 11.sp,
    color = colors.text.normal.copy(alpha = 0.6f),
  )
}

@Composable
private fun DeviceListItem(
  name: String,
  status: String,
  icon: String,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 8.dp, vertical = 6.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(icon, fontSize = 14.sp)
    Column(modifier = Modifier.weight(1f)) {
      Text(name, fontSize = 11.sp, maxLines = 1)
      Text(
        status,
        fontSize = 9.sp,
        color = Color(0xFF4CAF50),
      )
    }
  }
}

@Composable
private fun EmulatorListItem(
  name: String,
  apiLevel: String?,
  isIos: Boolean,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(4.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 8.dp, vertical = 6.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(
      imageVector = PlatformIcons.logo(isIos),
      contentDescription = PlatformIcons.contentDescription(isIos),
      tint = PlatformIcons.tint(isIos),
      modifier = Modifier.size(16.dp),
    )
    Column(modifier = Modifier.weight(1f)) {
      Text(name, fontSize = 11.sp, maxLines = 1)
      if (apiLevel != null) {
        Text(
          "API $apiLevel",
          fontSize = 9.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
        )
      }
    }
    Text("Boot", fontSize = 10.sp, color = Color(0xFF2196F3))
  }
}

@Composable
private fun SystemImageListItem(
  name: String,
  apiLevel: String,
  icon: String,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(4.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 8.dp, vertical = 6.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(icon, fontSize = 14.sp)
    Column(modifier = Modifier.weight(1f)) {
      Text(name, fontSize = 11.sp, maxLines = 1)
      Text(
        "API $apiLevel",
        fontSize = 9.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
    }
    Text("Create", fontSize = 10.sp, color = Color(0xFF2196F3))
  }
}
