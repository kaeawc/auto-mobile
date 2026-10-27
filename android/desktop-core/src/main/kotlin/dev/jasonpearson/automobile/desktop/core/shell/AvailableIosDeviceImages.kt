package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
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
internal fun IosImagesHeading(
  images: List<DeviceImageInfo>,
  showIos: Boolean,
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
      if (showIos) "\u25BE" else "\u25B8",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
    Spacer(Modifier.width(4.dp))
    Text(
      "\uD83C\uDF4E iOS",
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
internal fun IosImages(
  images: List<DeviceImageInfo>,
  filters: DeviceImageFilters,
  onSave: () -> Unit,
  onBootDevice: (DeviceImageInfo) -> Unit,
) {
  val colors = SharedTheme.globalColors
  with(filters) {
    // Collect all available versions sorted, for slider steps
    val allVersions =
      remember(images) {
        images
          .mapNotNull { it.osVersion }
          .distinct()
          .sortedWith(
            compareBy(
              { it.substringBefore('.').toIntOrNull() ?: 0 },
              { it.substringAfter('.', "0").toIntOrNull() ?: 0 },
            ),
          )
      }
    val range = remember(allVersions) { IosImageRange(allVersions, filters) }
    if (allVersions.size >= 2) IosVersionSliders(range, allVersions, filters, onSave)
    // iPhone / iPad chips
    Row(
      modifier = Modifier.padding(start = 12.dp),
      horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      FilterChip("iPhone", showIphone) {
        showIphone = !showIphone
        onSave()
      }
      FilterChip("iPad", showIpad) {
        showIpad = !showIpad
        onSave()
      }
    }
    Spacer(Modifier.height(2.dp))
    val selectedVersions = range.selectedVersions(allVersions)
    val filteredIos = filteredIosImages(images, selectedVersions, filters)
    IosImageList(filteredIos, onBootDevice)
  }
}

@Composable
private fun IosVersionSliders(
  range: IosImageRange,
  allVersions: List<String>,
  filters: DeviceImageFilters,
  onSave: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  with(range) {
    val maxIdx = (allVersions.size - 1).toFloat()
    // Clamp state in case allVersions changed
    val clampedMaxIdx = maxIdxState.coerceIn(0f, maxIdx)
    val clampedMinIdx = minIdx.coerceIn(0f, clampedMaxIdx)
    val minVer = allVersions.getOrElse(clampedMinIdx.toInt()) { allVersions.first() }
    val maxVer =
      allVersions.getOrElse(clampedMaxIdx.toInt().coerceAtMost(allVersions.size - 1)) {
        allVersions.last()
      }

    Row(
      verticalAlignment = Alignment.CenterVertically,
      modifier = Modifier.fillMaxWidth().padding(start = 12.dp),
    ) {
      Text(
        "$minVer\u2013$maxVer",
        fontSize = 9.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
        modifier = Modifier.width(65.dp),
      )
      Column(Modifier.weight(1f)) {
        MinimumIosSlider(range, allVersions, filters, onSave)
        MaximumIosSlider(range, allVersions, filters, onSave)
      }
    }
  }
}

@Composable
private fun MinimumIosSlider(
  range: IosImageRange,
  allVersions: List<String>,
  filters: DeviceImageFilters,
  onSave: () -> Unit,
) {
  with(range) {
    val maxIdx = (allVersions.size - 1).toFloat()
    val clampedMaxIdx = maxIdxState.coerceIn(0f, maxIdx)
    val clampedMinIdx = minIdx.coerceIn(0f, clampedMaxIdx)
    androidx.compose.material3.Slider(
      value = clampedMinIdx,
      modifier =
        Modifier.semantics { contentDescription = "Minimum iOS version" }
          .fillMaxWidth()
          .height(16.dp),
      onValueChange = { minIdx = it.coerceAtMost(clampedMaxIdx) },
      onValueChangeFinished = {
        filters.minIosVersion =
          allVersions[minIdx.coerceIn(0f, maxIdxState.coerceIn(0f, maxIdx)).toInt()]
        filters.maxIosVersion = allVersions[maxIdxState.coerceIn(0f, maxIdx).toInt()]
        onSave()
      },
      valueRange = 0f..maxIdx,
      steps = (allVersions.size - 2).coerceAtLeast(0),
    )
  }
}

@Composable
private fun MaximumIosSlider(
  range: IosImageRange,
  allVersions: List<String>,
  filters: DeviceImageFilters,
  onSave: () -> Unit,
) {
  with(range) {
    val maxIdx = (allVersions.size - 1).toFloat()
    val clampedMaxIdx = maxIdxState.coerceIn(0f, maxIdx)
    val clampedMinIdx = minIdx.coerceIn(0f, clampedMaxIdx)
    androidx.compose.material3.Slider(
      value = clampedMaxIdx,
      onValueChange = { maxIdxState = it.coerceAtLeast(clampedMinIdx) },
      onValueChangeFinished = {
        filters.minIosVersion =
          allVersions[minIdx.coerceIn(0f, maxIdxState.coerceIn(0f, maxIdx)).toInt()]
        filters.maxIosVersion = allVersions[maxIdxState.coerceIn(0f, maxIdx).toInt()]
        onSave()
      },
      valueRange = 0f..maxIdx,
      steps = (allVersions.size - 2).coerceAtLeast(0),
      modifier = Modifier.fillMaxWidth().height(16.dp),
    )
  }
}

private fun filteredIosImages(
  images: List<DeviceImageInfo>,
  selectedVersions: Set<String>,
  filters: DeviceImageFilters,
): List<DeviceImageInfo> {
  with(filters) {
    return images
      .filter { image ->
        val ver = image.osVersion
        val inRange = ver == null || ver in selectedVersions
        val isIphone = image.name.contains("iPhone", ignoreCase = true)
        val isIpad = image.name.contains("iPad", ignoreCase = true)
        val typeOk =
          when {
            isIphone -> showIphone
            isIpad -> showIpad
            else -> true // Apple Watch, Apple TV, etc.
          }
        inRange && typeOk
      }
      .sortedBy { it.name }
  }
}

@Composable
private fun IosImageList(
  filteredIos: List<DeviceImageInfo>,
  onBootDevice: (DeviceImageInfo) -> Unit,
) {
  val colors = SharedTheme.globalColors
  // Group by version, sorted descending
  val iosByVersion =
    filteredIos.groupBy { it.osVersion ?: "Unknown" }.toSortedMap(compareByDescending { it })
  iosByVersion.forEach { (version, images) ->
    Text(
      "iOS $version",
      fontSize = 9.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
      modifier = Modifier.padding(start = 12.dp, top = 4.dp),
    )
    images.forEach { image ->
      DeviceImageRow(
        image,
        onBootDevice,
        Modifier.padding(start = 16.dp, top = 1.dp, bottom = 1.dp),
      )
    }
  }
  if (filteredIos.isEmpty())
    Text(
      "No matching simulators",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.4f),
      modifier = Modifier.padding(start = 12.dp),
    )
}

private class IosImageRange(allVersions: List<String>, filters: DeviceImageFilters) {
  // Version slider — only shown when 2+ distinct versions exist
  var minIdx by
    mutableFloatStateOf(allVersions.indexOf(filters.minIosVersion).coerceAtLeast(0).toFloat())
  var maxIdxState by
    mutableFloatStateOf(
      (allVersions.indexOf(filters.maxIosVersion).takeIf { it >= 0 } ?: (allVersions.size - 1))
        .coerceAtLeast(minIdx.toInt())
        .toFloat(),
    )

  fun selectedVersions(allVersions: List<String>): Set<String> {
    // Determine selected version range
    return if (allVersions.size >= 2) {
      allVersions
        .subList(
          minIdx.toInt().coerceIn(0, allVersions.size - 1),
          (maxIdxState.toInt() + 1).coerceAtMost(allVersions.size),
        )
        .toSet()
    } else {
      allVersions.toSet()
    }
  }
}
