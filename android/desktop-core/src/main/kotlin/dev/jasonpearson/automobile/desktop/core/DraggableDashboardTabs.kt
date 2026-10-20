@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)

package dev.jasonpearson.automobile.desktop.core

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.components.Tooltip
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun DraggableTabs(options: DraggableTabsOptions) {
  LOG.debug(
    "DraggableTabs rendered with ${options.tabs.size} tabs, selectedIndex=${options.selectedIndex}",
  )
  val drag = remember { DashboardTabDragState() }
  BoxWithConstraints(
    modifier = Modifier.fillMaxWidth().background(SharedTheme.globalColors.panelBackground),
  ) {
    val layout = DashboardTabLayout(maxWidth < 300.dp, maxWidth >= 300.dp && maxWidth < 600.dp)
    Row(
      modifier = Modifier.padding(horizontal = 4.dp),
      horizontalArrangement = Arrangement.Start,
    ) {
      options.tabs.forEachIndexed { index, dashboard ->
        DraggableDashboardTab(options, drag, index, dashboard, layout)
      }
    }
  }
}

private data class DashboardTabLayout(val iconsOnly: Boolean, val iconsWithText: Boolean)

private class DashboardTabDragState {
  var tabPositions by mutableStateOf<Map<Int, Float>>(emptyMap())
  var dragOffset by mutableStateOf(0f)

  fun end(options: DraggableTabsOptions) {
    val from = options.draggedIndex
    val target = options.dropTargetIndex
    if (from != null && target != null && from != target) options.onReorder(from, target)
    dragOffset = 0f
    options.onDragEnd()
  }

  fun move(index: Int, delta: Float, options: DraggableTabsOptions) {
    dragOffset += delta / 2
    val positions = tabPositions.toList().sortedBy { it.second }
    val draggedPos = (tabPositions[index] ?: 0f) + dragOffset
    var newTarget: Int? = null
    for (i in positions.indices) {
      val (tabIdx, pos) = positions[i]
      val nextPos = positions.getOrNull(i + 1)?.second ?: (pos + 80f)
      if (draggedPos >= pos && draggedPos < nextPos) {
        newTarget = tabIdx
        break
      }
    }
    if (newTarget != null && newTarget != options.draggedIndex)
      options.onDropTargetChanged(newTarget)
    else if (newTarget == options.draggedIndex) options.onDropTargetChanged(null)
  }
}

private fun Modifier.dashboardTabInput(
  options: DraggableTabsOptions,
  drag: DashboardTabDragState,
  index: Int,
): Modifier = clickable {
  LOG.debug("Tab clicked via clickable: $index (${options.tabs[index]})")
  options.onTabSelected(index)
}
  .pointerInput("drag-$index") {
    detectDragGesturesAfterLongPress(
      onDragStart = { options.onDragStart(index) },
      onDragEnd = { drag.end(options) },
      onDragCancel = {
        drag.dragOffset = 0f
        options.onDragEnd()
      },
      onDrag = { change, dragAmount ->
        change.consume()
        drag.move(index, dragAmount.x, options)
      },
    )
  }

@Composable
private fun DraggableDashboardTab(
  options: DraggableTabsOptions,
  drag: DashboardTabDragState,
  index: Int,
  dashboard: Dashboard,
  layout: DashboardTabLayout,
) {
  val colors = SharedTheme.globalColors
  val selected = index == options.selectedIndex
  val dragged = index == options.draggedIndex
  val target =
    index == options.dropTargetIndex &&
      options.draggedIndex != null &&
      options.draggedIndex != index
  val background =
    when {
      target -> colors.text.normal.copy(alpha = 0.15f)
      selected -> colors.text.normal.copy(alpha = 0.1f)
      else -> Color.Transparent
    }
  Box(
    modifier =
      Modifier.padding(vertical = 4.dp, horizontal = 2.dp)
        .then(if (dragged) Modifier.offset(x = drag.dragOffset.dp) else Modifier)
        .background(background, RoundedCornerShape(6.dp))
        .then(
          if (target)
            Modifier.border(1.5.dp, Color(0xFF2196F3).copy(alpha = 0.5f), RoundedCornerShape(6.dp))
          else Modifier,
        )
        .dashboardTabInput(options, drag, index)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = if (layout.iconsOnly) 8.dp else 10.dp, vertical = 6.dp)
        .onGloballyPositioned {
          drag.tabPositions = drag.tabPositions + (index to it.positionInParent().x)
        },
    contentAlignment = Alignment.Center,
  ) {
    val textColor =
      when {
        dragged -> colors.text.normal.copy(alpha = 0.8f)
        selected -> colors.text.normal
        else -> colors.text.normal.copy(alpha = 0.6f)
      }
    DashboardTabLabel(dashboard, layout, textColor)
  }
}

@Composable
private fun DashboardTabLabel(dashboard: Dashboard, layout: DashboardTabLayout, textColor: Color) {
  when {
    layout.iconsOnly ->
      Tooltip(tooltip = { Text(dashboard.title, fontSize = 11.sp) }) {
        Text(dashboard.icon, fontSize = 14.sp)
      }
    layout.iconsWithText ->
      Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(dashboard.icon, fontSize = 12.sp)
        Text(dashboard.title, fontSize = 11.sp, maxLines = 1, softWrap = false, color = textColor)
      }
    else ->
      Text(dashboard.title, fontSize = 12.sp, maxLines = 1, softWrap = false, color = textColor)
  }
}
