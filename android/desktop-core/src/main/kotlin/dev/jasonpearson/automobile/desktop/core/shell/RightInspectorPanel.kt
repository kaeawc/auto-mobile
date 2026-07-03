package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.layout.HierarchyTreeView
import dev.jasonpearson.automobile.desktop.core.layout.LayoutInspectorState
import dev.jasonpearson.automobile.desktop.core.layout.PropertyInspectorPanel
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenshotLoader
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/**
 * Right inspector pane with Xcode-style header bar. Two modes: Event (telemetry detail) and Live
 * Layout (hierarchy + properties).
 */
@Composable
fun RightInspectorPanel(
  selectedEvent: TelemetryDisplayEvent?,
  onClose: () -> Unit,
  isLiveMode: Boolean = false,
  onToggleLiveMode: (Boolean) -> Unit = {},
  layoutInspectorState: LayoutInspectorState? = null,
  hasDevice: Boolean = false,
  onOpenSource: ((String, Int, String) -> Unit)? = null,
  screenshotLoader: ScreenshotLoader? = null,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val panelModifier = modifier.fillMaxSize().background(colors.panelBackground)

  if (!isLiveMode && selectedEvent == null) {
    InspectorEmptyState(modifier = panelModifier)
    return
  }

  val canShowLive = hasDevice && layoutInspectorState != null
  val isLayoutEvent = selectedEvent is TelemetryDisplayEvent.Layout

  Column(panelModifier) {
    // Header bar with mode toggle
    Row(
      Modifier.fillMaxWidth()
        .height(24.dp)
        .background(colors.text.normal.copy(alpha = 0.04f))
        .padding(horizontal = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      if (canShowLive && (isLayoutEvent || isLiveMode)) {
        InspectorTabButton("Event", !isLiveMode) { onToggleLiveMode(false) }
        Spacer(Modifier.width(2.dp))
        InspectorTabButton("Live Layout", isLiveMode) { onToggleLiveMode(true) }
      } else if (isLiveMode) {
        Text("Live Layout", fontSize = 10.sp, color = colors.text.info)
      } else if (selectedEvent != null) {
        Text(
          inspectorTitle(selectedEvent),
          fontSize = 10.sp,
          color = colors.text.normal.copy(alpha = 0.7f),
        )
      }
      Spacer(Modifier.weight(1f))
      Text(
        "\u2715",
        fontSize = 11.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
        modifier =
          Modifier.clickable(onClick = onClose).pointerHoverIcon(PointerIcon.Hand).padding(4.dp),
      )
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(colors.text.normal.copy(alpha = 0.08f)))

    // Content
    if (isLiveMode && layoutInspectorState != null) {
      LiveLayoutSplitPane(layoutInspectorState, Modifier.weight(1f))
    } else if (selectedEvent != null) {
      EventInspectorContent(
        event = selectedEvent,
        onClose = onClose,
        onOpenSource = onOpenSource,
        screenshotLoader = screenshotLoader,
        modifier = Modifier.weight(1f),
      )
    }
  }
}

@Composable
private fun LiveLayoutSplitPane(
  layoutInspectorState: LayoutInspectorState,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val splitFraction = remember { mutableFloatStateOf(0.6f) }
  val density = LocalDensity.current

  BoxWithConstraints(modifier.fillMaxSize()) {
    val totalHeightPx = constraints.maxHeight.toFloat()
    val topHeightPx = totalHeightPx * splitFraction.floatValue
    val dividerHeightPx = with(density) { 5.dp.toPx() }
    val bottomHeightPx = totalHeightPx - topHeightPx - dividerHeightPx

    Column(Modifier.fillMaxSize()) {
      Box(Modifier.fillMaxWidth().height(with(density) { topHeightPx.toDp() })) {
        HierarchyTreeView(
          hierarchy = layoutInspectorState.hierarchy,
          selectedElementId = layoutInspectorState.selectedElementId,
          hoveredElementId = layoutInspectorState.hoveredElementId,
          onElementSelected = { layoutInspectorState.selectElement(it) },
          onElementHovered = { layoutInspectorState.hoverElement(it) },
          parentMap = layoutInspectorState.parentMap,
          modifier = Modifier.fillMaxSize(),
        )
      }
      Box(
        Modifier.fillMaxWidth()
          .height(5.dp)
          .pointerHoverIcon(PointerIcon(java.awt.Cursor(java.awt.Cursor.N_RESIZE_CURSOR)))
          .pointerInput(Unit) {
            detectDragGestures { _, dragAmount ->
              val newFraction = splitFraction.floatValue + (dragAmount.y / totalHeightPx)
              splitFraction.floatValue = newFraction.coerceIn(0.1f, 0.9f)
            }
          },
        contentAlignment = Alignment.Center,
      ) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(colors.text.normal.copy(alpha = 0.10f)))
      }
      Box(Modifier.fillMaxWidth().height(with(density) { bottomHeightPx.toDp() })) {
        if (layoutInspectorState.selectedElementId != null) {
          PropertyInspectorPanel(
            element = layoutInspectorState.selectedElement,
            modifier = Modifier.fillMaxSize(),
          )
        } else {
          Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
              "Select an element to view properties",
              fontSize = 11.sp,
              color = colors.text.normal.copy(alpha = 0.4f),
            )
          }
        }
      }
    }
  }
}

@Composable
private fun InspectorTabButton(label: String, isActive: Boolean, onClick: () -> Unit) {
  val colors = SharedTheme.globalColors
  Text(
    label,
    fontSize = 10.sp,
    color = if (isActive) colors.text.info else colors.text.normal.copy(alpha = 0.5f),
    modifier =
      Modifier.clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .background(
          if (isActive) colors.text.normal.copy(alpha = 0.08f) else Color.Transparent,
          RoundedCornerShape(4.dp),
        )
        .padding(horizontal = 8.dp, vertical = 3.dp),
  )
}

private fun inspectorTitle(event: TelemetryDisplayEvent): String =
  when (event) {
    is TelemetryDisplayEvent.Network -> "${event.method} ${event.statusCode}"
    is TelemetryDisplayEvent.Navigation -> "Navigation"
    is TelemetryDisplayEvent.Failure -> event.type
    is TelemetryDisplayEvent.Log -> "Log (${event.level})"
    is TelemetryDisplayEvent.Os -> "OS: ${event.category}"
    is TelemetryDisplayEvent.Storage -> "Storage"
    is TelemetryDisplayEvent.Layout -> "Layout"
    is TelemetryDisplayEvent.Performance -> "Performance"
    is TelemetryDisplayEvent.Memory -> "Memory"
    is TelemetryDisplayEvent.ToolCall -> "Tool: ${event.toolName}"
    is TelemetryDisplayEvent.Accessibility -> "Accessibility"
  }
