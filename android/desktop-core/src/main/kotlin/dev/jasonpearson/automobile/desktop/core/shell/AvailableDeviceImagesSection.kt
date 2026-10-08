package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
  val colors = SharedTheme.globalColors
  // Device images (available to boot) — grouped by platform with filters
  if (images.isNotEmpty()) {
    Spacer(Modifier.height(12.dp))

    // Persisted filter state — read/write to ~/.automobile/device-filter.json
    val savedFilter = remember(filterFile) { loadDeviceFilter(filterFile) }
    var minApiFilter by remember {
      mutableFloatStateOf(savedFilter.minApi.toFloat().coerceIn(21f, 35f))
    }
    var maxApiFilter by remember {
      mutableFloatStateOf(savedFilter.maxApi.toFloat().coerceIn(minApiFilter, 35f))
    }
    var googleApisOnly by remember { mutableStateOf(savedFilter.googleApisOnly) }
    var minIosVersion by remember { mutableStateOf(savedFilter.minIosVersion) }
    var maxIosVersion by remember { mutableStateOf(savedFilter.maxIosVersion) }
    var showIphone by remember { mutableStateOf(savedFilter.showIphone) }
    var showIpad by remember { mutableStateOf(savedFilter.showIpad) }
    var imagesExpanded by remember { mutableStateOf(false) }

    fun saveFilters() {
      saveDeviceFilter(
        filterFile,
        minApiFilter.toInt(),
        maxApiFilter.toInt(),
        googleApisOnly,
        minIosVersion?.substringBefore('.')?.toIntOrNull() ?: savedFilter.minIos,
        maxIosVersion?.substringBefore('.')?.toIntOrNull() ?: savedFilter.maxIos,
        showIphone,
        showIpad,
        minIosVersion,
        maxIosVersion,
      )
    }

    Row(
      verticalAlignment = Alignment.CenterVertically,
      modifier =
        Modifier.fillMaxWidth()
          .clickable { imagesExpanded = !imagesExpanded }
          .pointerHoverIcon(PointerIcon.Hand),
    ) {
      Text(
        if (imagesExpanded) "\u25BE" else "\u25B8",
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
      Spacer(Modifier.width(4.dp))
      Text("Available Devices", color = colors.text.normal, fontSize = 14.sp)
      Spacer(Modifier.weight(1f))
      Text(
        "${images.size}",
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.4f),
      )
    }

    if (imagesExpanded) {
      Spacer(Modifier.height(4.dp))
      val androidImages = availableDeviceImages(images, bootedDevices, "android")
      val iosImages = availableDeviceImages(images, bootedDevices, "ios")
      var showAndroid by remember { mutableStateOf(true) }
      var showIos by remember { mutableStateOf(true) }

      // ── Android group ──
      if (androidImages.isNotEmpty()) {
        Row(
          verticalAlignment = Alignment.CenterVertically,
          modifier =
            Modifier.fillMaxWidth()
              .clickable { showAndroid = !showAndroid }
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
            "${androidImages.size}",
            fontSize = 9.sp,
            color = colors.text.normal.copy(alpha = 0.4f),
          )
        }
        if (showAndroid) {
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
                onValueChangeFinished = { saveFilters() },
                valueRange = 21f..35f,
                steps = 13,
              )
              androidx.compose.material3.Slider(
                value = maxApiFilter,
                onValueChange = { maxApiFilter = it.coerceAtLeast(minApiFilter) },
                onValueChangeFinished = { saveFilters() },
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
              saveFilters()
            }
          }
          Spacer(Modifier.height(2.dp))
          // Filtered list
          val filteredAndroid =
            androidImages
              .filter { image ->
                val apiLevel =
                  image.apiLevel
                    ?: Regex("""(?i)api[_-]?(\d+)""")
                      .find(image.name)
                      ?.groupValues
                      ?.get(1)
                      ?.toIntOrNull()
                val hasGoogleApis =
                  image.image.target?.contains("google", ignoreCase = true) == true ||
                    image.name.contains("-ga-", ignoreCase = true) ||
                    image.name.contains("Google", ignoreCase = true)
                if (googleApisOnly && !hasGoogleApis) return@filter false
                if (apiLevel != null) apiLevel in minApiFilter.toInt()..maxApiFilter.toInt()
                else true
              }
              .sortedBy { it.name }
          filteredAndroid.forEach { image ->
            Row(
              verticalAlignment = Alignment.CenterVertically,
              modifier = Modifier.fillMaxWidth().padding(start = 12.dp, top = 1.dp, bottom = 1.dp),
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
          if (filteredAndroid.isEmpty())
            Text(
              "No matching images",
              fontSize = 10.sp,
              color = colors.text.normal.copy(alpha = 0.4f),
              modifier = Modifier.padding(start = 12.dp),
            )
        }
      }

      // ── iOS group ──
      if (iosImages.isNotEmpty()) {
        Spacer(Modifier.height(4.dp))
        Row(
          verticalAlignment = Alignment.CenterVertically,
          modifier =
            Modifier.fillMaxWidth()
              .clickable { showIos = !showIos }
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
            "${iosImages.size}",
            fontSize = 9.sp,
            color = colors.text.normal.copy(alpha = 0.4f),
          )
        }
        if (showIos) {
          // Collect all available versions sorted, for slider steps
          val allVersions =
            remember(iosImages) {
              iosImages
                .mapNotNull { it.osVersion }
                .distinct()
                .sortedWith(
                  compareBy(
                    { it.substringBefore('.').toIntOrNull() ?: 0 },
                    { it.substringAfter('.', "0").toIntOrNull() ?: 0 },
                  ),
                )
            }
          // Version slider — only shown when 2+ distinct versions exist
          var minIdx by
            remember(allVersions) {
              mutableFloatStateOf(allVersions.indexOf(minIosVersion).coerceAtLeast(0).toFloat())
            }
          var maxIdxState by
            remember(allVersions) {
              mutableFloatStateOf(
                (allVersions.indexOf(maxIosVersion).takeIf { it >= 0 } ?: (allVersions.size - 1))
                  .coerceAtLeast(minIdx.toInt())
                  .toFloat(),
              )
            }
          if (allVersions.size >= 2) {
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
                androidx.compose.material3.Slider(
                  value = clampedMinIdx,
                  modifier =
                    Modifier.semantics { contentDescription = "Minimum iOS version" }
                      .fillMaxWidth()
                      .height(16.dp),
                  onValueChange = { minIdx = it.coerceAtMost(clampedMaxIdx) },
                  onValueChangeFinished = {
                    minIosVersion =
                      allVersions[minIdx.coerceIn(0f, maxIdxState.coerceIn(0f, maxIdx)).toInt()]
                    maxIosVersion = allVersions[maxIdxState.coerceIn(0f, maxIdx).toInt()]
                    saveFilters()
                  },
                  valueRange = 0f..maxIdx,
                  steps = (allVersions.size - 2).coerceAtLeast(0),
                )
                androidx.compose.material3.Slider(
                  value = clampedMaxIdx,
                  onValueChange = { maxIdxState = it.coerceAtLeast(clampedMinIdx) },
                  onValueChangeFinished = {
                    minIosVersion =
                      allVersions[minIdx.coerceIn(0f, maxIdxState.coerceIn(0f, maxIdx)).toInt()]
                    maxIosVersion = allVersions[maxIdxState.coerceIn(0f, maxIdx).toInt()]
                    saveFilters()
                  },
                  valueRange = 0f..maxIdx,
                  steps = (allVersions.size - 2).coerceAtLeast(0),
                  modifier = Modifier.fillMaxWidth().height(16.dp),
                )
              }
            }
          }

          // iPhone / iPad chips
          Row(
            modifier = Modifier.padding(start = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
          ) {
            FilterChip("iPhone", showIphone) {
              showIphone = !showIphone
              saveFilters()
            }
            FilterChip("iPad", showIpad) {
              showIpad = !showIpad
              saveFilters()
            }
          }
          Spacer(Modifier.height(2.dp))

          // Determine selected version range
          val selectedVersions =
            if (allVersions.size >= 2) {
              allVersions
                .subList(
                  minIdx.toInt().coerceIn(0, allVersions.size - 1),
                  (maxIdxState.toInt() + 1).coerceAtMost(allVersions.size),
                )
                .toSet()
            } else {
              allVersions.toSet()
            }

          // Filter by version range + device type
          val filteredIos =
            iosImages
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

          // Group by version, sorted descending
          val iosByVersion =
            filteredIos
              .groupBy { it.osVersion ?: "Unknown" }
              .toSortedMap(compareByDescending { it })
          iosByVersion.forEach { (version, images) ->
            Text(
              "iOS $version",
              fontSize = 9.sp,
              color = colors.text.normal.copy(alpha = 0.5f),
              modifier = Modifier.padding(start = 12.dp, top = 4.dp),
            )
            images.forEach { image ->
              Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier =
                  Modifier.fillMaxWidth().padding(start = 16.dp, top = 1.dp, bottom = 1.dp),
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
          }
          if (filteredIos.isEmpty())
            Text(
              "No matching simulators",
              fontSize = 10.sp,
              color = colors.text.normal.copy(alpha = 0.4f),
              modifier = Modifier.padding(start = 12.dp),
            )
        }
      }
    }
  }
}

@Composable
private fun FilterChip(label: String, selected: Boolean, onClick: () -> Unit) {
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
