package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.formatUiNumber
import dev.jasonpearson.automobile.desktop.core.layout.HierarchyTreeOptions
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenshotLoader
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@Composable
internal fun NavigationDetail(
  event: TelemetryDisplayEvent.Navigation,
  textColor: Color,
  screenshotLoader: ScreenshotLoader? = null,
) {
  DetailRow("Destination", event.destination, textColor)
  event.source?.let { DetailRow("Source", it, textColor) }
  event.triggeringInteraction?.let { DetailRow("Triggered by", it, textColor) }
  event.arguments?.forEach { (k, v) -> DetailRow("Arg: $k", v, textColor) }
  event.metadata?.forEach { (k, v) -> DetailRow("Meta: $k", v, textColor) }

  // Screenshot thumbnail
  val uri = event.screenshotUri
  if (uri != null && screenshotLoader != null) {
    Spacer(Modifier.height(8.dp))
    var bitmap by remember(uri) { mutableStateOf<ImageBitmap?>(null) }
    var loadFailed by remember(uri) { mutableStateOf(false) }
    LaunchedEffect(uri) {
      val result = screenshotLoader.load(uri)
      bitmap = result
      loadFailed = result == null
    }
    if (!loadFailed) {
      Box(
        modifier =
          Modifier.fillMaxWidth()
            .heightIn(max = 300.dp)
            .background(textColor.copy(alpha = 0.05f), RoundedCornerShape(4.dp)),
        contentAlignment = Alignment.Center,
      ) {
        val loadedBitmap = bitmap
        if (loadedBitmap != null) {
          Image(
            bitmap = loadedBitmap,
            contentDescription = "Screenshot of ${event.destination}",
            modifier = Modifier.fillMaxWidth(),
            contentScale = ContentScale.Fit,
          )
        } else {
          Text("Loading...", fontSize = 9.sp, color = textColor.copy(alpha = 0.4f))
        }
      }
    }
  }
}

@Composable
internal fun LogDetail(event: TelemetryDisplayEvent.Log, textColor: Color) {
  val levelName =
    when (event.level) {
      2 -> "VERBOSE"
      3 -> "DEBUG"
      4 -> "INFO"
      5 -> "WARN"
      6 -> "ERROR"
      7 -> "ASSERT"
      else -> "UNKNOWN"
    }
  DetailRow("Level", levelName, textColor)
  DetailRow("Tag", event.tag, textColor)
  Spacer(Modifier.height(4.dp))
  Text(
    event.message,
    fontSize = 10.sp,
    fontFamily = FontFamily.Monospace,
    color = textColor.copy(alpha = 0.85f),
  )
}

@Composable
internal fun OsDetail(event: TelemetryDisplayEvent.Os, textColor: Color) {
  DetailRow("Category", event.category, textColor)
  DetailRow("Kind", event.kind, textColor)
  event.details?.forEach { (k, v) -> DetailRow(k, v, textColor) }
}

@Composable
internal fun StorageDetail(event: TelemetryDisplayEvent.Storage, textColor: Color) {
  DetailRow("File", event.fileName, textColor)
  event.key?.let { DetailRow("Key", it, textColor) }
  DetailRow("Change Type", event.changeType, textColor)

  Spacer(Modifier.height(4.dp))

  val prevValue = event.previousValue
  val curValue = event.value
  when {
    curValue == null && event.changeType == "remove" && prevValue != null ->
      StorageChangedValue(
        "Removed value:",
        prevValue,
        Color(0xFFFF6B6B).copy(alpha = 0.8f),
        textColor,
      )
    prevValue == null && event.changeType == "add" ->
      curValue?.let {
        StorageChangedValue("New value:", it, Color(0xFF51CF66).copy(alpha = 0.8f), textColor)
      }
    prevValue != null && curValue != null -> {
      StorageChangedValue("Previous:", prevValue, Color(0xFFFF6B6B).copy(alpha = 0.7f), textColor)
      Spacer(Modifier.height(2.dp))
      StorageChangedValue("New:", curValue, Color(0xFF51CF66).copy(alpha = 0.8f), textColor)
    }
    else -> event.value?.let { DetailRow("Value", it, textColor) }
  }

  event.valueType?.let { DetailRow("Value Type", it, textColor) }
}

@Composable
internal fun StorageChangedValue(
  label: String,
  value: String,
  valueColor: Color,
  textColor: Color,
) {
  Text(
    label,
    fontSize = 9.sp,
    fontWeight = FontWeight.SemiBold,
    color = textColor.copy(alpha = 0.5f),
  )
  Text(
    value,
    fontSize = 10.sp,
    fontFamily = FontFamily.Monospace,
    color = valueColor,
    modifier = Modifier.padding(vertical = 1.dp),
  )
}

@Composable
internal fun LayoutDetailMetadata(event: TelemetryDisplayEvent.Layout, textColor: Color) {
  DetailRow("Sub-type", event.subType, textColor)
  event.screenName?.let { DetailRow("Screen", it, textColor) }
  event.composableName?.let { DetailRow("Composable", it, textColor) }
  event.recompositionCount?.let { DetailRow("Recomp/s", "$it", textColor) }
  event.durationMs?.let { DetailRow("Duration", "${it}ms", textColor) }
  event.likelyCause?.let { DetailRow("Likely Cause", it, textColor) }

  // Parse and display metadata from detailsJson (foreground activity, window count)
  val details = event.detailsJson
  if (details != null) {
    val metadata =
      remember(details) {
        try {
          val json = Json { ignoreUnknownKeys = true }
          val obj = json.parseToJsonElement(details).jsonObject
          val foreground =
            obj["foregroundActivity"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.content
          val windowCount = obj["windowCount"]?.jsonPrimitive?.intOrNull
          Pair(foreground, windowCount)
        } catch (error: IllegalArgumentException) {
          dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger("Telemetry")
            .debug("Invalid optional event data: ${error.message}")
          null
        }
      }
    if (metadata != null) {
      Spacer(Modifier.height(4.dp))
      metadata.first?.let { DetailRow("Foreground Activity", it, textColor) }
      metadata.second?.let { DetailRow("Windows", "$it", textColor) }
    }
  }
}

@Composable
internal fun LayoutDetailHierarchy(
  event: TelemetryDisplayEvent.Layout,
  modifier: Modifier = Modifier,
) {
  val details = event.detailsJson ?: return
  val parsed =
    remember(details) {
      try {
        val json = Json { ignoreUnknownKeys = true }
        val obj = json.parseToJsonElement(details).jsonObject
        obj["hierarchy"]?.let { hierarchyElement ->
          dev.jasonpearson.automobile.desktop.core.layout.parseHierarchyFromJson(
            buildJsonObject { put("hierarchy", hierarchyElement) },
          )
        }
      } catch (error: IllegalArgumentException) {
        dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory.getLogger("Telemetry")
          .debug("Invalid optional event data: ${error.message}")
        null
      }
    }
  val hierarchy = parsed ?: return

  dev.jasonpearson.automobile.desktop.core.layout.HierarchyTreeView(
    options =
      HierarchyTreeOptions(
        hierarchy = hierarchy.root,
        selectedElementId = null,
        hoveredElementId = null,
        onElementSelected = {},
        onElementHovered = {},
        parentMap = hierarchy.parentMap,
      ),
    modifier = modifier,
  )
}

@Composable
internal fun PerformanceDetail(event: TelemetryDisplayEvent.Performance, textColor: Color) {
  val healthColor =
    when (event.health) {
      "critical" -> Color(0xFFFF4040)
      "warning" -> Color(0xFFFFA94D)
      else -> Color(0xFF51CF66)
    }

  Row(
    modifier = Modifier.padding(vertical = 2.dp),
    horizontalArrangement = Arrangement.spacedBy(4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      modifier =
        Modifier.background(healthColor.copy(alpha = 0.2f), RoundedCornerShape(3.dp))
          .padding(horizontal = 6.dp, vertical = 1.dp),
    ) {
      Text(
        event.health.uppercase(),
        fontSize = 9.sp,
        fontWeight = FontWeight.Bold,
        color = healthColor,
      )
    }
  }

  if (event.changedMetrics.isNotEmpty()) {
    DetailRow("Changed", event.changedMetrics.joinToString(", "), textColor)
  }

  Spacer(Modifier.height(4.dp))
  event.fps?.let { DetailRow("Frame Rate", "${it.toInt()} fps", textColor) }
  event.frameTimeMs?.let { DetailRow("Frame Time", "${it.toInt()} ms", textColor) }
  event.jankFrames?.let { DetailRow("Jank Frames", "$it", textColor) }
  event.touchLatencyMs?.let { DetailRow("Touch Latency", "${it.toInt()} ms", textColor) }
  event.memoryUsageMb?.let { DetailRow("Memory", "${it.toInt()} MB", textColor) }
  event.cpuUsagePercent?.let { DetailRow("CPU", "${formatUiNumber("%.1f", it)}%", textColor) }
}

@Composable
internal fun MemoryDetail(event: TelemetryDisplayEvent.Memory, textColor: Color) {
  val resultColor = if (event.passed) Color(0xFF51CF66) else Color(0xFFFF6B6B)
  Row(
    modifier = Modifier.padding(vertical = 2.dp),
    horizontalArrangement = Arrangement.spacedBy(4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      modifier =
        Modifier.background(resultColor.copy(alpha = 0.2f), RoundedCornerShape(3.dp))
          .padding(horizontal = 6.dp, vertical = 1.dp),
    ) {
      Text(
        if (event.passed) "PASSED" else "FAILED",
        fontSize = 9.sp,
        fontWeight = FontWeight.Bold,
        color = resultColor,
      )
    }
  }
  DetailRow("Package", event.packageName, textColor)
  event.javaHeapGrowthMb?.let {
    DetailRow("Java Heap Growth", "${formatUiNumber("%.2f", it)} MB", textColor)
  }
  event.nativeHeapGrowthMb?.let {
    DetailRow("Native Heap Growth", "${formatUiNumber("%.2f", it)} MB", textColor)
  }
  event.gcCount?.let { DetailRow("GC Count", "$it", textColor) }
  event.gcDurationMs?.let { DetailRow("GC Duration", "${it}ms", textColor) }
  event.unreachableObjects?.let { DetailRow("Unreachable Objects", "$it", textColor) }
  if (event.violations.isNotEmpty()) {
    Spacer(Modifier.height(4.dp))
    DetailRow("Violations", event.violations.joinToString(", "), textColor)
  }
}

@Composable
internal fun ToolCallDetail(event: TelemetryDisplayEvent.ToolCall, textColor: Color) {
  DetailRow("Tool", event.toolName, textColor)
  DetailRow("Duration", "${event.durationMs}ms", textColor)
  DetailRow("Success", if (event.success) "Yes" else "No", textColor)
  event.error?.let { DetailRow("Error", it, textColor) }
}

@Composable
internal fun AccessibilityDetail(event: TelemetryDisplayEvent.Accessibility, textColor: Color) {
  DetailRow("Package", event.packageName, textColor)
  DetailRow("Screen", event.screenId, textColor)
  DetailRow("New Violations", "${event.newViolations}", textColor)
  DetailRow("Total Violations", "${event.totalViolations}", textColor)
  if (event.baselinedCount > 0) {
    DetailRow("Baselined", "${event.baselinedCount}", textColor)
  }

  if (event.violations.isNotEmpty()) {
    Spacer(Modifier.height(8.dp))
    for (v in event.violations) {
      val sevColor =
        when (v.severity) {
          "error" -> Color(0xFFFF6B6B)
          "warning" -> Color(0xFFFFA94D)
          else -> textColor.copy(alpha = 0.6f)
        }
      Row(modifier = Modifier.padding(vertical = 2.dp)) {
        Text(
          "[${v.criterion}] ",
          fontSize = 9.sp,
          fontFamily = FontFamily.Monospace,
          fontWeight = FontWeight.SemiBold,
          color = sevColor,
        )
        Text(
          "${v.type}: ${v.message}",
          fontSize = 9.sp,
          fontFamily = FontFamily.Monospace,
          color = textColor.copy(alpha = 0.75f),
        )
      }
    }
  }
}
