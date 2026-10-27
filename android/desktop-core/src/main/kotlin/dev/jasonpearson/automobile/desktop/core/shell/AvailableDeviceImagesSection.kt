package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.DeviceFilterState
import dev.jasonpearson.automobile.desktop.core.availableDeviceImages
import dev.jasonpearson.automobile.desktop.core.loadDeviceFilter
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDevice
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo
import dev.jasonpearson.automobile.desktop.core.saveDeviceFilter
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import java.io.File

/** Available images with persisted platform filters. Booting is owned by the host. */
@Composable
internal fun AvailableDeviceImagesSection(
  images: List<DeviceImageInfo>,
  bootedDevices: List<BootedDevice>,
  onBootDevice: (DeviceImageInfo) -> Unit,
  filterFile: File = File(System.getProperty("user.home"), ".automobile/device-filter.json"),
) {
  if (images.isNotEmpty()) {
    Spacer(Modifier.height(12.dp))
    val savedFilter = remember(filterFile) { loadDeviceFilter(filterFile) }
    val filters = remember { DeviceImageFilters(savedFilter) }
    val onSave = { filters.saveFilters(filterFile, savedFilter) }
    var imagesExpanded by remember { mutableStateOf(false) }
    AvailableImagesHeading(images.size, imagesExpanded) { imagesExpanded = !imagesExpanded }
    if (imagesExpanded) {
      Spacer(Modifier.height(4.dp))
      val androidImages = availableDeviceImages(images, bootedDevices, "android")
      val iosImages = availableDeviceImages(images, bootedDevices, "ios")
      var showAndroid by remember { mutableStateOf(true) }
      var showIos by remember { mutableStateOf(true) }
      if (androidImages.isNotEmpty()) {
        AndroidImagesHeading(androidImages, showAndroid) { showAndroid = !showAndroid }
        if (showAndroid) AndroidImages(androidImages, filters, onSave, onBootDevice)
      }
      if (iosImages.isNotEmpty()) {
        Spacer(Modifier.height(4.dp))
        IosImagesHeading(iosImages, showIos) { showIos = !showIos }
        if (showIos) IosImages(iosImages, filters, onSave, onBootDevice)
      }
    }
  }
}

internal class DeviceImageFilters(savedFilter: DeviceFilterState) {
  var minApiFilter by mutableFloatStateOf(savedFilter.minApi.toFloat().coerceIn(21f, 35f))
  var maxApiFilter by mutableFloatStateOf(savedFilter.maxApi.toFloat().coerceIn(minApiFilter, 35f))
  var googleApisOnly by mutableStateOf(savedFilter.googleApisOnly)
  var minIosVersion by mutableStateOf(savedFilter.minIosVersion)
  var maxIosVersion by mutableStateOf(savedFilter.maxIosVersion)
  var showIphone by mutableStateOf(savedFilter.showIphone)
  var showIpad by mutableStateOf(savedFilter.showIpad)

  fun saveFilters(filterFile: File, savedFilter: DeviceFilterState) {
    saveDeviceFilter(
      filterFile,
      DeviceFilterState(
        minApiFilter.toInt(),
        maxApiFilter.toInt(),
        googleApisOnly,
        minIosVersion?.substringBefore('.')?.toIntOrNull() ?: savedFilter.minIos,
        maxIosVersion?.substringBefore('.')?.toIntOrNull() ?: savedFilter.maxIos,
        showIphone,
        showIpad,
        minIosVersion,
        maxIosVersion,
      ),
    )
  }
}

@Composable
private fun AvailableImagesHeading(imageCount: Int, imagesExpanded: Boolean, onToggle: () -> Unit) {
  val colors = SharedTheme.globalColors
  Row(
    verticalAlignment = Alignment.CenterVertically,
    modifier =
      Modifier.fillMaxWidth().clickable(onClick = onToggle).pointerHoverIcon(PointerIcon.Hand),
  ) {
    Text(
      if (imagesExpanded) "\u25BE" else "\u25B8",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
    Spacer(Modifier.width(4.dp))
    Text("Available Devices", color = colors.text.normal, fontSize = 14.sp)
    Spacer(Modifier.weight(1f))
    Text("$imageCount", fontSize = 10.sp, color = colors.text.normal.copy(alpha = 0.4f))
  }
}

@Composable
internal fun DeviceImageRow(
  image: DeviceImageInfo,
  onBootDevice: (DeviceImageInfo) -> Unit,
  modifier: Modifier,
) {
  val colors = SharedTheme.globalColors
  Row(
    verticalAlignment = Alignment.CenterVertically,
    modifier = Modifier.fillMaxWidth().then(modifier),
  ) {
    Text(
      image.name,
      color = colors.text.normal.copy(alpha = 0.6f),
      fontSize = 10.sp,
      modifier = Modifier.weight(1f),
      maxLines = 1,
      overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
    )
    Text(
      "\u25B6",
      fontSize = 9.sp,
      color = Color(0xFF4CAF50).copy(alpha = 0.7f),
      modifier =
        Modifier.semantics { contentDescription = "Boot ${image.name}" }
          .clickable {
            onBootDevice(image)
          }
          .pointerHoverIcon(PointerIcon.Hand)
          .padding(4.dp),
    )
  }
}

@Composable
internal fun FilterChip(label: String, selected: Boolean, onClick: () -> Unit) {
  val colors = SharedTheme.globalColors
  Text(
    text = label,
    fontSize = 10.sp,
    color = if (selected) colors.text.info else colors.text.normal.copy(alpha = 0.5f),
    modifier =
      Modifier.semantics { this.selected = selected }
        .background(
          if (selected) colors.text.info.copy(alpha = 0.12f)
          else colors.text.normal.copy(alpha = 0.06f),
          RoundedCornerShape(12.dp),
        )
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 10.dp, vertical = 4.dp),
  )
}
