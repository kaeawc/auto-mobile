package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.clipboard.LocalClipboardWriter
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import java.util.Date
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * Detail panel for showing full event information when a row is clicked.
 *
 * Layout events with a hierarchy tree use a split layout: scrollable metadata on top, and the full
 * HierarchyTreeView filling the remaining space below (it has its own internal LazyColumn and
 * cannot nest inside verticalScroll).
 */
@Composable
fun TelemetryDetailPanel(options: TelemetryDetailOptions) {
  with(options) {
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
            .padding(12.dp),
      ) {
        TelemetryDetailHeader(options) { showCopiedToast = true }

        if (showCopiedToast) {
          Box(
            modifier =
              Modifier.padding(top = 4.dp)
                .background(textColor.copy(alpha = 0.08f), RoundedCornerShape(4.dp))
                .padding(horizontal = 8.dp, vertical = 2.dp),
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
        TelemetryEventDetail(options)
      }

      // Hierarchy tree fills remaining space (only for layout events with hierarchy data)
      if (event is TelemetryDisplayEvent.Layout && isLayoutWithHierarchy) {
        LayoutDetailHierarchy(event, modifier = Modifier.weight(1f))
      }
    }
  }
}

private fun detailTitle(event: TelemetryDisplayEvent): String =
  when (event) {
    is TelemetryDisplayEvent.Network -> "Network Request"
    is TelemetryDisplayEvent.Navigation -> "Navigation"
    is TelemetryDisplayEvent.Log -> "Log Entry"
    is TelemetryDisplayEvent.Os -> "OS Event"
    is TelemetryDisplayEvent.Failure -> failureDetailTitle(event.type)
    is TelemetryDisplayEvent.Storage -> "Storage Change"
    is TelemetryDisplayEvent.Layout -> "Layout Event"
    is TelemetryDisplayEvent.Performance -> "Performance"
    is TelemetryDisplayEvent.Memory -> "Memory Audit"
    is TelemetryDisplayEvent.ToolCall -> "Tool Call"
    is TelemetryDisplayEvent.Accessibility -> "Accessibility"
  }

/** Serialize a [TelemetryDisplayEvent] to a compact JSON string for clipboard sharing. */
private fun serializeEventToJson(event: TelemetryDisplayEvent): String {
  val obj = buildJsonObject {
    put("timestamp", JsonPrimitive(event.timestamp))
    when (event) {
      is TelemetryDisplayEvent.Network -> serializeNetwork(event)
      is TelemetryDisplayEvent.Failure -> serializeFailure(event)
      is TelemetryDisplayEvent.Log -> serializeLog(event)
      is TelemetryDisplayEvent.Navigation -> serializeNavigation(event)
      is TelemetryDisplayEvent.Os -> serializeOs(event)
      is TelemetryDisplayEvent.Storage -> serializeStorage(event)
      is TelemetryDisplayEvent.Layout -> serializeLayout(event)
      is TelemetryDisplayEvent.Performance -> serializePerformance(event)
      is TelemetryDisplayEvent.Memory -> serializeMemory(event)
      is TelemetryDisplayEvent.ToolCall -> serializeToolCall(event)
      is TelemetryDisplayEvent.Accessibility -> serializeAccessibility(event)
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

/** Failure event detail with tabbed sub-views: Summary and Stack Trace. */

/**
 * JSON syntax highlighting using AnnotatedString. Colors: keys=blue, string values=green,
 * numbers=orange, booleans/null=purple.
 */

/** Metadata portion of layout detail (rendered in the scrollable section). */

/**
 * Hierarchy tree portion of layout detail. Rendered outside the verticalScroll container so
 * HierarchyTreeView's internal LazyColumn works correctly.
 */
@Composable
private fun TelemetryDetailHeader(options: TelemetryDetailOptions, onCopied: () -> Unit) {
  with(options) {
    val focusedBorderColor = SharedTheme.globalColors.outlines.focused
    val clipboard = LocalClipboardWriter.current
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
            onCopied()
          },
        )
        HeaderIconButton(
          icon = "MD",
          textColor = textColor,
          focusedBorderColor = focusedBorderColor,
          onClick = {
            clipboard.copyEventAsMarkdown(event)
            onCopied()
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
  }
}

@Composable
private fun TelemetryEventDetail(options: TelemetryDetailOptions) {
  with(options) {
    val focusedBorderColor = SharedTheme.globalColors.outlines.focused
    when (event) {
      is TelemetryDisplayEvent.Network -> NetworkTabbedDetail(event, textColor, focusedBorderColor)
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
}

private fun failureDetailTitle(type: String): String =
  when (type) {
    "crash" -> "Crash"
    "anr" -> "ANR"
    else -> "Non-Fatal"
  }
