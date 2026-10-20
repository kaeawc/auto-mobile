package dev.jasonpearson.automobile.desktop.core

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.mcp.AvailableEmulator
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDevice
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceType
import dev.jasonpearson.automobile.desktop.core.mcp.SystemImage
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

private data class DeviceManagementActions(
  val onDeviceSelected: (String) -> Unit,
  val onBootEmulator: (String) -> Unit,
  val onCreateEmulator: (String) -> Unit,
)

@Composable
private fun DeviceManagementPanel(
  bootedDevices: List<BootedDevice>,
  availableEmulators: List<AvailableEmulator>,
  systemImages: List<SystemImage>,
  actions: DeviceManagementActions,
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
    ActiveDeviceSection(androidDevices, iosDevices, actions)
    AvailableEmulatorSection(androidEmulators, iosSimulators, actions)
    SystemImageSection(androidImages, iosImages, actions)
  }
}

@Composable
private fun ActiveDeviceSection(
  androidDevices: List<BootedDevice>,
  iosDevices: List<BootedDevice>,
  actions: DeviceManagementActions,
) {
  // Active Devices section
  if (androidDevices.isNotEmpty() || iosDevices.isNotEmpty()) {
    DeviceSectionHeader("Active Devices")
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      ActiveDeviceColumn(
        "Android",
        androidDevices,
        DeviceType.AndroidPhysical,
        actions,
        Modifier.weight(1f),
      )
      ActiveDeviceColumn("iOS", iosDevices, DeviceType.iOSPhysical, actions, Modifier.weight(1f))
    }
  }
}

@Composable
private fun AvailableEmulatorSection(
  androidEmulators: List<AvailableEmulator>,
  iosSimulators: List<AvailableEmulator>,
  actions: DeviceManagementActions,
) {
  // Available Emulators/Simulators section
  if (androidEmulators.isNotEmpty() || iosSimulators.isNotEmpty()) {
    DeviceSectionHeader("Available to Boot")
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      EmulatorColumn(androidEmulators, false, actions.onBootEmulator, Modifier.weight(1f))
      EmulatorColumn(iosSimulators, true, actions.onBootEmulator, Modifier.weight(1f))
    }
  }
}

@Composable
private fun SystemImageSection(
  androidImages: List<SystemImage>,
  iosImages: List<SystemImage>,
  actions: DeviceManagementActions,
) {
  // System Images section
  if (androidImages.isNotEmpty() || iosImages.isNotEmpty()) {
    DeviceSectionHeader("System Images")
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      SystemImageColumn(androidImages, actions.onCreateEmulator, Modifier.weight(1f))
      SystemImageColumn(iosImages, actions.onCreateEmulator, Modifier.weight(1f))
    }
  }
}

@Composable
private fun ActiveDeviceColumn(
  title: String,
  devices: List<BootedDevice>,
  physicalType: DeviceType,
  actions: DeviceManagementActions,
  modifier: Modifier,
) {
  val colors = SharedTheme.globalColors
  Column(
    modifier = modifier,
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    Text(title, fontSize = 10.sp, color = colors.text.normal.copy(alpha = 0.5f))
    if (devices.isEmpty()) {
      Text("None", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.3f))
    } else {
      devices.forEach { device ->
        DeviceListItem(
          name = device.name,
          status = device.status,
          icon = if (device.type == physicalType) "📱" else "📲",
          onClick = { actions.onDeviceSelected(device.id) },
        )
      }
    }
  }
}

@Composable
private fun EmulatorColumn(
  emulators: List<AvailableEmulator>,
  isIos: Boolean,
  onBootEmulator: (String) -> Unit,
  modifier: Modifier,
) {
  Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
    emulators.forEach { emulator ->
      EmulatorListItem(
        name = emulator.name,
        apiLevel = if (isIos) null else emulator.apiLevel,
        isIos = isIos,
        onClick = { onBootEmulator(emulator.id) },
      )
    }
  }
}

@Composable
private fun SystemImageColumn(
  images: List<SystemImage>,
  onCreateEmulator: (String) -> Unit,
  modifier: Modifier,
) {
  Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
    images.forEach { image ->
      SystemImageListItem(
        name = image.name,
        apiLevel = image.apiLevel,
        icon = "💿",
        onClick = { onCreateEmulator(image.id) },
      )
    }
  }
}
