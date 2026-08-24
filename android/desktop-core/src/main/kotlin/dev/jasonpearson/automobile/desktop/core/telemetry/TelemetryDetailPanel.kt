package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.clipboard.LocalClipboardWriter
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenshotLoader
import dev.jasonpearson.automobile.desktop.core.shell.InspectorTabBar
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import java.text.SimpleDateFormat
import java.util.Date
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Detail panel for showing full event information when a row is clicked.
 *
 * Layout events with a hierarchy tree use a split layout: scrollable metadata on top, and the full
 * HierarchyTreeView filling the remaining space below (it has its own internal LazyColumn and
 * cannot nest inside verticalScroll).
 */
@Composable
fun TelemetryDetailPanel(
  event: TelemetryDisplayEvent,
  timeFormat: SimpleDateFormat,
  textColor: Color,
  onClose: () -> Unit,
  onOpenSource: ((String, Int, String) -> Unit)? = null,
  screenshotLoader: ScreenshotLoader? = null,
  modifier: Modifier = Modifier,
) {
  // Layout events with hierarchy need a split layout — scrollable metadata on top,
  // HierarchyTreeView (LazyColumn) filling remaining space below.
  val isLayoutWithHierarchy =
    event is TelemetryDisplayEvent.Layout &&
      event.subType == "hierarchy_change" &&
      event.detailsJson != null

  val focusedBorderColor = SharedTheme.globalColors.outlines.focused

  val clipboard = LocalClipboardWriter.current

  // Toast state for share-to-clipboard confirmation
  var showCopiedToast by remember { mutableStateOf(false) }
  LaunchedEffect(showCopiedToast) {
    if (showCopiedToast) {
      kotlinx.coroutines.delay(1500)
      showCopiedToast = false
    }
  }

  Column(modifier = modifier.fillMaxHeight().background(textColor.copy(alpha = 0.03f))) {
    Column(
      modifier =
        Modifier.then(if (isLayoutWithHierarchy) Modifier else Modifier.weight(1f))
          .verticalScroll(rememberScrollState())
          .padding(12.dp)
    ) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          detailTitle(event),
          fontSize = 13.sp,
          fontWeight = FontWeight.SemiBold,
          color = textColor,
          modifier = Modifier.weight(1f),
        )
        Row(
          horizontalArrangement = Arrangement.spacedBy(4.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          HeaderIconButton(
            icon = "\u2197",
            textColor = textColor,
            focusedBorderColor = focusedBorderColor,
            onClick = {
              clipboard.writeText(serializeEventToJson(event))
              showCopiedToast = true
            },
          )
          HeaderIconButton(
            icon = "MD",
            textColor = textColor,
            focusedBorderColor = focusedBorderColor,
            onClick = {
              clipboard.copyEventAsMarkdown(event)
              showCopiedToast = true
            },
          )
          HeaderIconButton(
            icon = "\u2715",
            textColor = textColor,
            focusedBorderColor = focusedBorderColor,
            onClick = onClose,
          )
        }
      }

      if (showCopiedToast) {
        Box(
          modifier =
            Modifier.padding(top = 4.dp)
              .background(textColor.copy(alpha = 0.08f), RoundedCornerShape(4.dp))
              .padding(horizontal = 8.dp, vertical = 2.dp)
        ) {
          Text(
            "Copied to clipboard",
            fontSize = 9.sp,
            color = textColor.copy(alpha = 0.6f),
          )
        }
      }

      Spacer(Modifier.height(4.dp))

      // Timestamp
      val formattedTime = remember(event.timestamp) { timeFormat.format(Date(event.timestamp)) }
      DetailRow("Time", formattedTime, textColor)

      Spacer(Modifier.height(8.dp))

      // Type-specific detail — Network and Failure use tabbed sub-views
      when (event) {
        is TelemetryDisplayEvent.Network ->
          NetworkTabbedDetail(event, textColor, focusedBorderColor)
        is TelemetryDisplayEvent.Failure ->
          FailureTabbedDetail(event, textColor, onOpenSource, focusedBorderColor)
        is TelemetryDisplayEvent.Navigation -> NavigationDetail(event, textColor, screenshotLoader)
        is TelemetryDisplayEvent.Log -> LogDetail(event, textColor)
        is TelemetryDisplayEvent.Os -> OsDetail(event, textColor)
        is TelemetryDisplayEvent.Storage -> StorageDetail(event, textColor)
        is TelemetryDisplayEvent.Layout -> LayoutDetailMetadata(event, textColor)
        is TelemetryDisplayEvent.Performance -> PerformanceDetail(event, textColor)
        is TelemetryDisplayEvent.Memory -> MemoryDetail(event, textColor)
        is TelemetryDisplayEvent.ToolCall -> ToolCallDetail(event, textColor)
        is TelemetryDisplayEvent.Accessibility -> AccessibilityDetail(event, textColor)
      }
    }

    // Hierarchy tree fills remaining space (only for layout events with hierarchy data)
    if (event is TelemetryDisplayEvent.Layout && isLayoutWithHierarchy) {
      LayoutDetailHierarchy(event, modifier = Modifier.weight(1f))
    }
  }
}

private fun detailTitle(event: TelemetryDisplayEvent): String =
  when (event) {
    is TelemetryDisplayEvent.Network -> "Network Request"
    is TelemetryDisplayEvent.Navigation -> "Navigation"
    is TelemetryDisplayEvent.Log -> "Log Entry"
    is TelemetryDisplayEvent.Os -> "OS Event"
    is TelemetryDisplayEvent.Failure ->
      when (event.type) {
        "crash" -> "Crash"
        "anr" -> "ANR"
        else -> "Non-Fatal"
      }
    is TelemetryDisplayEvent.Storage -> "Storage Change"
    is TelemetryDisplayEvent.Layout -> "Layout Event"
    is TelemetryDisplayEvent.Performance -> "Performance"
    is TelemetryDisplayEvent.Memory -> "Memory Audit"
    is TelemetryDisplayEvent.ToolCall -> "Tool Call"
    is TelemetryDisplayEvent.Accessibility -> "Accessibility"
  }

@Composable
private fun DetailRow(label: String, value: String, textColor: Color) {
  val interactionSource = remember { MutableInteractionSource() }
  val isHovered by interactionSource.collectIsHoveredAsState()
  val clipboard = LocalClipboardWriter.current

  Row(
    modifier = Modifier.fillMaxWidth().hoverable(interactionSource).padding(vertical = 2.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      label,
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      color = textColor.copy(alpha = 0.5f),
      modifier = Modifier.padding(end = 4.dp),
    )
    Text(
      value,
      fontSize = 10.sp,
      fontFamily = FontFamily.Monospace,
      color = textColor.copy(alpha = 0.85f),
      modifier = Modifier.weight(1f),
    )
    if (isHovered) {
      Box(
        modifier =
          Modifier.clickable { clipboard.writeText(value) }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(2.dp)
      ) {
        Text("\uD83D\uDCCB", fontSize = 9.sp) // 📋
      }
    }
  }
}

@Composable
private fun HeaderIconButton(
  icon: String,
  textColor: Color,
  focusedBorderColor: Color,
  onClick: () -> Unit,
) {
  var isFocused by remember { mutableStateOf(false) }
  Box(
    modifier =
      Modifier.onFocusChanged { isFocused = it.isFocused }
        .then(
          if (isFocused) Modifier.border(2.dp, focusedBorderColor, RoundedCornerShape(4.dp))
          else Modifier
        )
        .background(textColor.copy(alpha = 0.1f), RoundedCornerShape(4.dp))
        .clickable { onClick() }
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 6.dp, vertical = 2.dp)
  ) {
    Text(icon, fontSize = 11.sp, color = textColor.copy(alpha = 0.6f))
  }
}

/** Serialize a [TelemetryDisplayEvent] to a compact JSON string for clipboard sharing. */
private fun serializeEventToJson(event: TelemetryDisplayEvent): String {
  val obj = buildJsonObject {
    put("timestamp", JsonPrimitive(event.timestamp))
    when (event) {
      is TelemetryDisplayEvent.Network -> {
        put("type", JsonPrimitive("network"))
        put("method", JsonPrimitive(event.method))
        put("statusCode", JsonPrimitive(event.statusCode))
        put("url", JsonPrimitive(event.url))
        put("durationMs", JsonPrimitive(event.durationMs))
        event.host?.let { put("host", JsonPrimitive(it)) }
        event.path?.let { put("path", JsonPrimitive(it)) }
        event.error?.let { put("error", JsonPrimitive(it)) }
        event.requestBody?.let { put("requestBody", JsonPrimitive(it)) }
        event.responseBody?.let { put("responseBody", JsonPrimitive(it)) }
        event.contentType?.let { put("contentType", JsonPrimitive(it)) }
        event.requestHeaders?.let { headers ->
          put(
            "requestHeaders",
            buildJsonObject {
              headers.forEach { (k, v) ->
                val redacted =
                  if (
                    k.equals("Authorization", ignoreCase = true) ||
                      k.equals("Cookie", ignoreCase = true) ||
                      k.equals("Set-Cookie", ignoreCase = true)
                  )
                    "[REDACTED]"
                  else v
                put(k, JsonPrimitive(redacted))
              }
            },
          )
        }
        event.responseHeaders?.let { headers ->
          put(
            "responseHeaders",
            buildJsonObject {
              headers.forEach { (k, v) ->
                val redacted = if (k.equals("Set-Cookie", ignoreCase = true)) "[REDACTED]" else v
                put(k, JsonPrimitive(redacted))
              }
            },
          )
        }
      }
      is TelemetryDisplayEvent.Failure -> {
        put("type", JsonPrimitive(event.type))
        put("severity", JsonPrimitive(event.severity))
        put("title", JsonPrimitive(event.title))
        put("occurrenceId", JsonPrimitive(event.occurrenceId))
        event.exceptionType?.let { put("exceptionType", JsonPrimitive(it)) }
        event.screen?.let { put("screen", JsonPrimitive(it)) }
        event.stackTrace?.let { frames ->
          put(
            "stackTrace",
            buildJsonArray {
              frames.forEach { f ->
                add(
                  buildJsonObject {
                    put("className", JsonPrimitive(f.className))
                    put("methodName", JsonPrimitive(f.methodName))
                    f.fileName?.let { put("fileName", JsonPrimitive(it)) }
                    f.lineNumber?.let { put("lineNumber", JsonPrimitive(it)) }
                    put("isAppCode", JsonPrimitive(f.isAppCode))
                  }
                )
              }
            },
          )
        }
      }
      is TelemetryDisplayEvent.Log -> {
        put("type", JsonPrimitive("log"))
        put("level", JsonPrimitive(event.level))
        put("tag", JsonPrimitive(event.tag))
        put("message", JsonPrimitive(event.message))
      }
      is TelemetryDisplayEvent.Navigation -> {
        put("type", JsonPrimitive("navigation"))
        put("destination", JsonPrimitive(event.destination))
        event.source?.let { put("source", JsonPrimitive(it)) }
        event.triggeringInteraction?.let { put("triggeringInteraction", JsonPrimitive(it)) }
      }
      is TelemetryDisplayEvent.Os -> {
        put("type", JsonPrimitive("os"))
        put("category", JsonPrimitive(event.category))
        put("kind", JsonPrimitive(event.kind))
      }
      is TelemetryDisplayEvent.Storage -> {
        put("type", JsonPrimitive("storage"))
        put("fileName", JsonPrimitive(event.fileName))
        event.key?.let { put("key", JsonPrimitive(it)) }
        event.value?.let { put("value", JsonPrimitive(it)) }
        put("changeType", JsonPrimitive(event.changeType))
        event.previousValue?.let { put("previousValue", JsonPrimitive(it)) }
      }
      is TelemetryDisplayEvent.Layout -> {
        put("type", JsonPrimitive("layout"))
        put("subType", JsonPrimitive(event.subType))
        event.composableName?.let { put("composableName", JsonPrimitive(it)) }
        event.screenName?.let { put("screenName", JsonPrimitive(it)) }
        event.durationMs?.let { put("durationMs", JsonPrimitive(it)) }
      }
      is TelemetryDisplayEvent.Performance -> {
        put("type", JsonPrimitive("performance"))
        put("health", JsonPrimitive(event.health))
        event.fps?.let { put("fps", JsonPrimitive(it)) }
        event.frameTimeMs?.let { put("frameTimeMs", JsonPrimitive(it)) }
        event.cpuUsagePercent?.let { put("cpuUsagePercent", JsonPrimitive(it)) }
        event.memoryUsageMb?.let { put("memoryUsageMb", JsonPrimitive(it)) }
      }
      is TelemetryDisplayEvent.Memory -> {
        put("type", JsonPrimitive("memory"))
        put("packageName", JsonPrimitive(event.packageName))
        put("passed", JsonPrimitive(event.passed))
      }
      is TelemetryDisplayEvent.ToolCall -> {
        put("type", JsonPrimitive("toolcall"))
        put("toolName", JsonPrimitive(event.toolName))
        put("durationMs", JsonPrimitive(event.durationMs))
        put("success", JsonPrimitive(event.success))
        event.error?.let { put("error", JsonPrimitive(it)) }
      }
      is TelemetryDisplayEvent.Accessibility -> {
        put("type", JsonPrimitive("accessibility"))
        put("packageName", JsonPrimitive(event.packageName))
        put("screenId", JsonPrimitive(event.screenId))
        put("totalViolations", JsonPrimitive(event.totalViolations))
        put("newViolations", JsonPrimitive(event.newViolations))
        put("baselinedCount", JsonPrimitive(event.baselinedCount))
        if (event.violations.isNotEmpty()) {
          put(
            "violations",
            buildJsonArray {
              event.violations.forEach { v ->
                add(
                  buildJsonObject {
                    put("type", JsonPrimitive(v.type))
                    put("severity", JsonPrimitive(v.severity))
                    put("criterion", JsonPrimitive(v.criterion))
                    put("message", JsonPrimitive(v.message))
                  }
                )
              }
            },
          )
        }
      }
    }
  }
  return Json.encodeToString(JsonObject.serializer(), obj)
}

/**
 * Network event detail with tabbed sub-views: Overview, Headers, Request, Response.
 *
 * Replay state ([replayResult] and [isRunning]) is hoisted here so it survives tab switches — if
 * they lived inside [NetworkOverviewTab] they would be disposed whenever the user navigated away
 * from that tab.
 */
@Composable
private fun NetworkTabbedDetail(
  event: TelemetryDisplayEvent.Network,
  textColor: Color,
  focusedBorderColor: Color,
) {
  val tabs = listOf("Overview", "Headers", "Request", "Response")
  var selectedTab by remember(event) { mutableStateOf(0) }

  // Hoist replay state to this level so it persists across tab switches.
  var replayResult by remember(event) { mutableStateOf<NetworkReplayResult?>(null) }
  var isRunning by remember(event) { mutableStateOf(false) }

  InspectorTabBar(
    tabs = tabs,
    selected = selectedTab,
    onSelect = { selectedTab = it },
    textColor = textColor,
    focusedBorderColor = focusedBorderColor,
  )

  when (selectedTab) {
    0 ->
      NetworkOverviewTab(
        event = event,
        textColor = textColor,
        replayResult = replayResult,
        isRunning = isRunning,
        onRunReplay = {
          isRunning = true
          replayResult = null
          Thread {
            val result =
              NetworkRequestRunner.run(
                url = event.url,
                method = event.method,
                requestHeaders = event.requestHeaders,
                requestBody = event.requestBody,
              )
            javax.swing.SwingUtilities.invokeLater {
              replayResult = result
              isRunning = false
            }
          }
            .start()
        },
      )
    1 -> NetworkHeadersTab(event, textColor)
    2 -> NetworkRequestTab(event, textColor)
    3 -> NetworkResponseTab(event, textColor)
  }
}

@Composable
private fun NetworkOverviewTab(
  event: TelemetryDisplayEvent.Network,
  textColor: Color,
  replayResult: NetworkReplayResult?,
  isRunning: Boolean,
  onRunReplay: () -> Unit,
) {
  DetailRow("Method", event.method, textColor)
  DetailRow("Status", "${event.statusCode}", textColor)
  DetailRow("URL", event.url, textColor)
  DetailRow("Duration", "${event.durationMs}ms", textColor)
  event.host?.let { DetailRow("Host", it, textColor) }
  event.path?.let { DetailRow("Path", it, textColor) }
  event.error?.let { DetailRow("Error", it, textColor) }

  val reqSize = (event.requestHeaders?.get("Content-Length")?.toLongOrNull()) ?: -1
  val respSize = (event.responseHeaders?.get("Content-Length")?.toLongOrNull()) ?: -1
  if (reqSize > 0) DetailRow("Request Size", formatByteSize(reqSize), textColor)
  if (respSize > 0) DetailRow("Response Size", formatByteSize(respSize), textColor)

  // cURL command
  Spacer(Modifier.height(8.dp))
  val curlCommand = remember(event) { networkAsCurl(event) }
  CollapsibleSection("cURL", textColor, copyText = curlCommand) {
    MonospaceBlock(curlCommand, textColor)
  }

  // Run button — state is owned by the parent NetworkTabbedDetail so it
  // persists when the user switches away from this tab and back.
  Spacer(Modifier.height(8.dp))
  ActionButton(if (isRunning) "Running..." else "Run", textColor, enabled = !isRunning) {
    onRunReplay()
  }

  val result = replayResult
  if (result != null) {
    Spacer(Modifier.height(8.dp))
    Text(
      "Replay Result",
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      color = textColor.copy(alpha = 0.7f),
    )
    Spacer(Modifier.height(4.dp))
    DetailRow("Status", "${result.statusCode}", textColor)
    DetailRow("Duration", "${result.durationMs}ms", textColor)
    result.error?.let { DetailRow("Error", it, textColor) }
    val replayRespHeadersCopy =
      result.responseHeaders.entries.joinToString("\n") { "${it.key}: ${it.value}" }
    CollapsibleSection(
      "Response Headers",
      textColor,
      defaultExpanded = false,
      copyText = replayRespHeadersCopy,
    ) {
      if (result.responseHeaders.isNotEmpty()) {
        HeaderDataTable(result.responseHeaders, textColor)
      } else {
        Text("No headers", fontSize = 9.sp, color = textColor.copy(alpha = 0.35f))
      }
    }
    CollapsibleSection("Response Body", textColor, copyText = result.responseBody) {
      val contentType =
        result.responseHeaders.entries
          .find { it.key.equals("content-type", ignoreCase = true) }
          ?.value
      if (result.responseBodyBytes != null && contentType?.startsWith("image/") == true) {
        // Render image from raw bytes
        val bitmap =
          remember(result.responseBodyBytes) {
            try {
              org.jetbrains.skia.Image.makeFromEncoded(result.responseBodyBytes)
                .toComposeImageBitmap()
            } catch (_: Exception) {
              null
            }
          }
        if (bitmap != null) {
          Box(
            Modifier.fillMaxWidth()
              .background(textColor.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
              .padding(8.dp)
          ) {
            Image(
              bitmap = bitmap,
              contentDescription = "Response image",
              modifier = Modifier.fillMaxWidth().heightIn(max = 400.dp),
              contentScale = ContentScale.Fit,
            )
          }
        } else {
          Text(
            "Image (${contentType}, ${formatByteSize(result.responseBodyBytes.size.toLong())})",
            fontSize = 9.sp,
            color = textColor.copy(alpha = 0.4f),
          )
        }
      } else {
        NetworkBodyContent(
          body = result.responseBody,
          contentType = contentType,
          bodySize =
            result.responseBody?.length?.toLong() ?: result.responseBodyBytes?.size?.toLong() ?: -1,
          textColor = textColor,
        )
      }
    }
  }
}

@Composable
private fun NetworkHeadersTab(event: TelemetryDisplayEvent.Network, textColor: Color) {
  val reqHeadersCopy =
    remember(event.requestHeaders) {
      event.requestHeaders?.entries?.joinToString("\n") { "${it.key}: ${it.value}" }
    }
  CollapsibleSection(
    "Request Headers",
    textColor,
    defaultExpanded = !event.requestHeaders.isNullOrEmpty(),
    copyText = reqHeadersCopy,
  ) {
    val reqHeaders = event.requestHeaders
    if (!reqHeaders.isNullOrEmpty()) {
      HeaderDataTable(reqHeaders, textColor)
    } else {
      Text("No headers captured", fontSize = 9.sp, color = textColor.copy(alpha = 0.35f))
    }
  }

  Spacer(Modifier.height(8.dp))

  val respHeadersCopy =
    remember(event.responseHeaders) {
      event.responseHeaders?.entries?.joinToString("\n") { "${it.key}: ${it.value}" }
    }
  CollapsibleSection(
    "Response Headers",
    textColor,
    defaultExpanded = !event.responseHeaders.isNullOrEmpty(),
    copyText = respHeadersCopy,
  ) {
    val respHeaders = event.responseHeaders
    if (!respHeaders.isNullOrEmpty()) {
      HeaderDataTable(respHeaders, textColor)
    } else {
      Text("No headers captured", fontSize = 9.sp, color = textColor.copy(alpha = 0.35f))
    }
  }
}

@Composable
private fun NetworkRequestTab(event: TelemetryDisplayEvent.Network, textColor: Color) {
  val reqSize = (event.requestHeaders?.get("Content-Length")?.toLongOrNull()) ?: -1
  CollapsibleSection(
    "Request Body",
    textColor,
    defaultExpanded = !event.requestBody.isNullOrBlank(),
    copyText = event.requestBody,
  ) {
    NetworkBodyContent(
      body = event.requestBody,
      contentType = event.requestHeaders?.get("Content-Type"),
      bodySize = reqSize,
      textColor = textColor,
    )
  }
}

@Composable
private fun NetworkResponseTab(event: TelemetryDisplayEvent.Network, textColor: Color) {
  val respSize = (event.responseHeaders?.get("Content-Length")?.toLongOrNull()) ?: -1
  CollapsibleSection(
    "Response Body",
    textColor,
    defaultExpanded = !event.responseBody.isNullOrBlank(),
    copyText = event.responseBody,
  ) {
    NetworkBodyContent(
      body = event.responseBody,
      contentType = event.contentType,
      bodySize = respSize,
      textColor = textColor,
    )
  }
}

/** Failure event detail with tabbed sub-views: Summary and Stack Trace. */
@Composable
private fun FailureTabbedDetail(
  event: TelemetryDisplayEvent.Failure,
  textColor: Color,
  onOpenSource: ((String, Int, String) -> Unit)?,
  focusedBorderColor: Color,
) {
  val tabs = listOf("Summary", "Stack Trace")
  var selectedTab by remember(event) { mutableStateOf(0) }

  InspectorTabBar(
    tabs = tabs,
    selected = selectedTab,
    onSelect = { selectedTab = it },
    textColor = textColor,
    focusedBorderColor = focusedBorderColor,
  )

  when (selectedTab) {
    0 -> FailureSummaryTab(event, textColor)
    1 -> FailureStackTraceTab(event, textColor, onOpenSource)
  }
}

@Composable
private fun FailureSummaryTab(event: TelemetryDisplayEvent.Failure, textColor: Color) {
  val severityColor =
    when (event.severity) {
      "critical" -> Color(0xFFFF4040)
      "high" -> Color(0xFFFF6B6B)
      "medium" -> Color(0xFFE0C040)
      else -> textColor.copy(alpha = 0.7f)
    }

  Row(
    modifier = Modifier.padding(vertical = 2.dp),
    horizontalArrangement = Arrangement.spacedBy(4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      modifier =
        Modifier.background(severityColor.copy(alpha = 0.2f), RoundedCornerShape(3.dp))
          .padding(horizontal = 6.dp, vertical = 1.dp)
    ) {
      Text(
        event.severity.uppercase(),
        fontSize = 9.sp,
        fontWeight = FontWeight.Bold,
        color = severityColor,
      )
    }
  }

  DetailRow("Type", event.type, textColor)
  DetailRow("Title", event.title, textColor)
  event.exceptionType?.let { DetailRow("Exception", it, textColor) }
  event.screen?.let { DetailRow("Screen", it, textColor) }
  DetailRow("Occurrence ID", event.occurrenceId, textColor)
}

@Composable
private fun FailureStackTraceTab(
  event: TelemetryDisplayEvent.Failure,
  textColor: Color,
  onOpenSource: ((String, Int, String) -> Unit)?,
) {
  val frames = event.stackTrace
  if (frames.isNullOrEmpty()) {
    Text("No stack trace available", fontSize = 9.sp, color = textColor.copy(alpha = 0.35f))
    return
  }

  for (frame in frames) {
    val location = buildString {
      append(frame.fileName ?: frame.className.substringAfterLast('.'))
      if (frame.lineNumber != null) append(":${frame.lineNumber}")
    }
    val frameText = "at ${frame.className}.${frame.methodName}($location)"

    val fName = frame.fileName
    val fLine = frame.lineNumber
    if (frame.isAppCode && onOpenSource != null && fName != null && fLine != null) {
      Text(
        frameText,
        fontSize = 9.sp,
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.SemiBold,
        color = textColor.copy(alpha = 0.9f),
        modifier =
          Modifier.clickable { onOpenSource(fName, fLine, frame.className) }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(vertical = 1.dp),
      )
    } else {
      Text(
        frameText,
        fontSize = 9.sp,
        fontFamily = FontFamily.Monospace,
        color = textColor.copy(alpha = 0.4f),
        modifier = Modifier.padding(vertical = 1.dp),
      )
    }
  }
}

@Composable
private fun CollapsibleSection(
  title: String,
  textColor: Color,
  defaultExpanded: Boolean = true,
  copyText: String? = null,
  content: @Composable () -> Unit,
) {
  val focusedBorderColor = SharedTheme.globalColors.outlines.focused
  val clipboard = LocalClipboardWriter.current
  var expanded by remember { mutableStateOf(defaultExpanded) }
  var isFocused by remember { mutableStateOf(false) }
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .onFocusChanged { isFocused = it.isFocused }
        .then(
          if (isFocused) Modifier.border(2.dp, focusedBorderColor, RoundedCornerShape(4.dp))
          else Modifier
        )
        .clickable { expanded = !expanded }
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(vertical = 2.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      if (expanded) "\u25BE" else "\u25B8",
      fontSize = 9.sp,
      color = textColor.copy(alpha = 0.5f),
    )
    Spacer(Modifier.width(4.dp))
    Text(
      title,
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      color = textColor.copy(alpha = 0.7f),
      modifier = Modifier.weight(1f),
    )
    if (copyText != null && expanded) {
      var copyIsFocused by remember { mutableStateOf(false) }
      Box(
        modifier =
          Modifier.onFocusChanged { copyIsFocused = it.isFocused }
            .then(
              if (copyIsFocused) Modifier.border(2.dp, focusedBorderColor, RoundedCornerShape(4.dp))
              else Modifier
            )
            .clickable { clipboard.writeText(copyText) }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(4.dp)
      ) {
        Text("\uD83D\uDCCB", fontSize = 10.sp) // clipboard icon
      }
    }
  }
  if (expanded) {
    content()
  }
}

@Composable
private fun MonospaceBlock(text: String, textColor: Color) {
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(textColor.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
        .padding(6.dp)
  ) {
    Text(
      text,
      fontSize = 9.sp,
      fontFamily = FontFamily.Monospace,
      color = textColor.copy(alpha = 0.8f),
    )
  }
}

/**
 * JSON syntax highlighting using AnnotatedString. Colors: keys=blue, string values=green,
 * numbers=orange, booleans/null=purple.
 */
@Composable
private fun SyntaxHighlightedJson(json: String, textColor: Color) {
  val annotated = remember(json, textColor) { buildSyntaxHighlightedJson(json, textColor) }
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(textColor.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
        .padding(6.dp)
  ) {
    Text(
      annotated,
      fontSize = 9.sp,
      fontFamily = FontFamily.Monospace,
    )
  }
}

private fun buildSyntaxHighlightedJson(json: String, baseColor: Color): AnnotatedString {
  val keyColor = Color(0xFF82AAFF)
  val stringColor = Color(0xFF98C379)
  val numberColor = Color(0xFFE5C07B)
  val keywordColor = Color(0xFFC678DD)
  val defaultColor = baseColor.copy(alpha = 0.85f)

  return buildAnnotatedString {
    var i = 0
    while (i < json.length) {
      val c = json[i]
      when {
        c == '"' -> {
          // Find end of string
          var j = i + 1
          while (j < json.length) {
            if (json[j] == '\\') {
              j += 2
              continue
            }
            if (json[j] == '"') {
              j++
              break
            }
            j++
          }
          val token = json.substring(i, j)
          // Look ahead for ':' to determine if this is a key
          var k = j
          while (k < json.length && (json[k] == ' ' || json[k] == '\t' || json[k] == '\n')) k++
          val isKey = k < json.length && json[k] == ':'
          withStyle(SpanStyle(color = if (isKey) keyColor else stringColor)) {
            append(token)
          }
          i = j
        }
        json.startsWith("true", i) || json.startsWith("false", i) || json.startsWith("null", i) -> {
          val end =
            when {
              json.startsWith("true", i) -> i + 4
              json.startsWith("false", i) -> i + 5
              else -> i + 4
            }
          withStyle(SpanStyle(color = keywordColor)) { append(json.substring(i, end)) }
          i = end
        }
        c == '-' || c.isDigit() -> {
          var j = i
          if (j < json.length && json[j] == '-') j++
          while (
            j < json.length &&
              (json[j].isDigit() ||
                json[j] == '.' ||
                json[j] == 'e' ||
                json[j] == 'E' ||
                json[j] == '+' ||
                json[j] == '-')
          ) j++
          withStyle(SpanStyle(color = numberColor)) { append(json.substring(i, j)) }
          i = j
        }
        else -> {
          withStyle(SpanStyle(color = defaultColor)) { append(c) }
          i++
        }
      }
    }
  }
}

@Composable
private fun ActionButton(
  label: String,
  textColor: Color,
  enabled: Boolean = true,
  onClick: () -> Unit,
) {
  val focusedBorderColor = SharedTheme.globalColors.outlines.focused
  var isFocused by remember { mutableStateOf(false) }
  Box(
    modifier =
      Modifier.onFocusChanged { isFocused = it.isFocused }
        .then(
          if (isFocused) Modifier.border(2.dp, focusedBorderColor, RoundedCornerShape(4.dp))
          else Modifier
        )
        .background(
          if (enabled) textColor.copy(alpha = 0.12f) else textColor.copy(alpha = 0.05f),
          RoundedCornerShape(4.dp),
        )
        .then(
          if (enabled) Modifier.clickable { onClick() }.pointerHoverIcon(PointerIcon.Hand)
          else Modifier
        )
        .padding(horizontal = 10.dp, vertical = 4.dp)
  ) {
    Text(
      label,
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      color = if (enabled) textColor.copy(alpha = 0.8f) else textColor.copy(alpha = 0.4f),
    )
  }
}

@Composable
private fun NavigationDetail(
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
private fun LogDetail(event: TelemetryDisplayEvent.Log, textColor: Color) {
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
private fun OsDetail(event: TelemetryDisplayEvent.Os, textColor: Color) {
  DetailRow("Category", event.category, textColor)
  DetailRow("Kind", event.kind, textColor)
  event.details?.forEach { (k, v) -> DetailRow(k, v, textColor) }
}

@Composable
private fun StorageDetail(event: TelemetryDisplayEvent.Storage, textColor: Color) {
  DetailRow("File", event.fileName, textColor)
  event.key?.let { DetailRow("Key", it, textColor) }
  DetailRow("Change Type", event.changeType, textColor)

  Spacer(Modifier.height(4.dp))

  val prevValue = event.previousValue
  val curValue = event.value
  when {
    // Value removed — show only the previous value
    curValue == null && event.changeType == "remove" && prevValue != null -> {
      Text(
        "Removed value:",
        fontSize = 9.sp,
        fontWeight = FontWeight.SemiBold,
        color = textColor.copy(alpha = 0.5f),
      )
      Text(
        prevValue,
        fontSize = 10.sp,
        fontFamily = FontFamily.Monospace,
        color = Color(0xFFFF6B6B).copy(alpha = 0.8f),
        modifier = Modifier.padding(vertical = 1.dp),
      )
    }
    // New key added — show only the new value
    prevValue == null && event.changeType == "add" -> {
      curValue?.let { v ->
        Text(
          "New value:",
          fontSize = 9.sp,
          fontWeight = FontWeight.SemiBold,
          color = textColor.copy(alpha = 0.5f),
        )
        Text(
          v,
          fontSize = 10.sp,
          fontFamily = FontFamily.Monospace,
          color = Color(0xFF51CF66).copy(alpha = 0.8f),
          modifier = Modifier.padding(vertical = 1.dp),
        )
      }
    }
    // Modified — show before/after
    prevValue != null && curValue != null -> {
      Text(
        "Previous:",
        fontSize = 9.sp,
        fontWeight = FontWeight.SemiBold,
        color = textColor.copy(alpha = 0.5f),
      )
      Text(
        prevValue,
        fontSize = 10.sp,
        fontFamily = FontFamily.Monospace,
        color = Color(0xFFFF6B6B).copy(alpha = 0.7f),
        modifier = Modifier.padding(vertical = 1.dp),
      )
      Spacer(Modifier.height(2.dp))
      Text(
        "New:",
        fontSize = 9.sp,
        fontWeight = FontWeight.SemiBold,
        color = textColor.copy(alpha = 0.5f),
      )
      Text(
        curValue,
        fontSize = 10.sp,
        fontFamily = FontFamily.Monospace,
        color = Color(0xFF51CF66).copy(alpha = 0.8f),
        modifier = Modifier.padding(vertical = 1.dp),
      )
    }
    // Fallback — just show value
    else -> {
      event.value?.let { DetailRow("Value", it, textColor) }
    }
  }

  event.valueType?.let { DetailRow("Value Type", it, textColor) }
}

/** Metadata portion of layout detail (rendered in the scrollable section). */
@Composable
private fun LayoutDetailMetadata(event: TelemetryDisplayEvent.Layout, textColor: Color) {
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
        } catch (_: Exception) {
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

/**
 * Hierarchy tree portion of layout detail. Rendered outside the verticalScroll container so
 * HierarchyTreeView's internal LazyColumn works correctly.
 */
@Composable
private fun LayoutDetailHierarchy(
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
            buildJsonObject { put("hierarchy", hierarchyElement) }
          )
        }
      } catch (_: Exception) {
        null
      }
    }
  val hierarchy = parsed ?: return

  dev.jasonpearson.automobile.desktop.core.layout.HierarchyTreeView(
    hierarchy = hierarchy.root,
    selectedElementId = null,
    hoveredElementId = null,
    onElementSelected = {},
    onElementHovered = {},
    parentMap = hierarchy.parentMap,
    modifier = modifier,
  )
}

@Composable
private fun PerformanceDetail(event: TelemetryDisplayEvent.Performance, textColor: Color) {
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
          .padding(horizontal = 6.dp, vertical = 1.dp)
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
  event.cpuUsagePercent?.let { DetailRow("CPU", "${"%.1f".format(it)}%", textColor) }
}

@Composable
private fun MemoryDetail(event: TelemetryDisplayEvent.Memory, textColor: Color) {
  val resultColor = if (event.passed) Color(0xFF51CF66) else Color(0xFFFF6B6B)
  Row(
    modifier = Modifier.padding(vertical = 2.dp),
    horizontalArrangement = Arrangement.spacedBy(4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      modifier =
        Modifier.background(resultColor.copy(alpha = 0.2f), RoundedCornerShape(3.dp))
          .padding(horizontal = 6.dp, vertical = 1.dp)
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
    DetailRow("Java Heap Growth", "${"%.2f".format(it)} MB", textColor)
  }
  event.nativeHeapGrowthMb?.let {
    DetailRow("Native Heap Growth", "${"%.2f".format(it)} MB", textColor)
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
private fun ToolCallDetail(event: TelemetryDisplayEvent.ToolCall, textColor: Color) {
  DetailRow("Tool", event.toolName, textColor)
  DetailRow("Duration", "${event.durationMs}ms", textColor)
  DetailRow("Success", if (event.success) "Yes" else "No", textColor)
  event.error?.let { DetailRow("Error", it, textColor) }
}

@Composable
private fun AccessibilityDetail(event: TelemetryDisplayEvent.Accessibility, textColor: Color) {
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
