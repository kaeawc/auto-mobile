package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun AndroidImagesHeading(
  images: List<DeviceImageInfo>,
  showAndroid: Boolean,
  onToggle: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  Row(
    verticalAlignment = Alignment.CenterVertically,
    modifier =
      Modifier.fillMaxWidth()
        .clickable { onToggle() }
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(vertical = 2.dp),
  ) {
    Text(
      if (showAndroid) "\u25BE" else "\u25B8",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
    Spacer(Modifier.width(4.dp))
    Text(
      "\uD83E\uDD16 Android",
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.7f),
    )
    Spacer(Modifier.weight(1f))
    Text(
      "${images.size}",
      fontSize = 9.sp,
      color = colors.text.normal.copy(alpha = 0.4f),
    )
  }
}

@Composable
internal fun AndroidImages(
  images: List<DeviceImageInfo>,
  filters: DeviceImageFilters,
  onSave: () -> Unit,
  onBootDevice: (DeviceImageInfo) -> Unit,
) {
  val colors = SharedTheme.globalColors
  AndroidImageControls(filters, onSave)
  val filteredAndroid = filteredAndroidImages(images, filters)
  filteredAndroid.forEach { image ->
    DeviceImageRow(image, onBootDevice, Modifier.padding(start = 12.dp, top = 1.dp, bottom = 1.dp))
  }
  if (filteredAndroid.isEmpty())
    Text(
      "No matching images",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.4f),
      modifier = Modifier.padding(start = 12.dp),
    )
}

@Composable
private fun AndroidImageControls(filters: DeviceImageFilters, onSave: () -> Unit) {
  val colors = SharedTheme.globalColors
  with(filters) {
    // API range sliders
    Row(
      verticalAlignment = Alignment.CenterVertically,
      modifier = Modifier.fillMaxWidth().padding(start = 12.dp),
    ) {
      Text(
        "API ${minApiFilter.toInt()}-${maxApiFilter.toInt()}",
        fontSize = 9.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
        modifier = Modifier.width(55.dp),
      )
      Column(Modifier.weight(1f)) {
        androidx.compose.material3.Slider(
          value = minApiFilter,
          modifier =
            Modifier.semantics { contentDescription = "Minimum Android API" }
              .fillMaxWidth()
              .height(16.dp),
          onValueChange = { minApiFilter = it.coerceAtMost(maxApiFilter) },
          onValueChangeFinished = { onSave() },
          valueRange = 21f..35f,
          steps = 13,
        )
        androidx.compose.material3.Slider(
          value = maxApiFilter,
          onValueChange = { maxApiFilter = it.coerceAtLeast(minApiFilter) },
          onValueChangeFinished = { onSave() },
          valueRange = 21f..35f,
          steps = 13,
          modifier = Modifier.fillMaxWidth().height(16.dp),
        )
      }
    }
    // Google APIs chip
    Row(modifier = Modifier.padding(start = 12.dp)) {
      FilterChip("Google APIs", googleApisOnly) {
        googleApisOnly = !googleApisOnly
        onSave()
      }
    }
    Spacer(Modifier.height(2.dp))
  }
}

private fun filteredAndroidImages(
  images: List<DeviceImageInfo>,
  filters: DeviceImageFilters,
): List<DeviceImageInfo> {
  with(filters) {
    return images
      .filter { image ->
        val apiLevel =
          image.apiLevel
            ?: Regex("""(?i)api[_-]?(\d+)""").find(image.name)?.groupValues?.get(1)?.toIntOrNull()
        val hasGoogleApis =
          image.image.target?.contains("google", ignoreCase = true) == true ||
            image.name.contains("-ga-", ignoreCase = true) ||
            image.name.contains("Google", ignoreCase = true)
        if (googleApisOnly && !hasGoogleApis) return@filter false
        if (apiLevel != null) apiLevel in minApiFilter.toInt()..maxApiFilter.toInt() else true
      }
      .sortedBy { it.name }
  }
}
