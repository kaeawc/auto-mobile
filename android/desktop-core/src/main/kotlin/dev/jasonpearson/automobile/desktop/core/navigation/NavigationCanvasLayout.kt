@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity

@Composable
internal fun rememberCanvasLayout(options: NavigationCanvasOptions): NavigationCanvasLayout =
  with(options) {
    val density = LocalDensity.current
    // Compute node positions using D3-style force-directed layout
    val nodePositions =
      remember(screens, transitions) {
        computeNodePositions(screens, transitions, density)
      }

    // Create lookup maps
    val screenById = remember(screens) { screens.associateBy { it.id } }
    val screenByName = remember(screens) { screens.associateBy { it.name } }
    val positionByName = remember(nodePositions) { nodePositions.associateBy { it.screenId } }

    // Convert dp to px for drawing
    val nodeWidthPx = with(density) { NODE_WIDTH.toPx() }
    val nodeHeightPx = with(density) { NODE_HEIGHT.toPx() }

    // Compute edge hit zones (right edge to left edge, matching actual line drawing)
    val edgeHitZones =
      remember(transitions, positionByName, nodeWidthPx, nodeHeightPx) {
        val forwardTransitions = transitions.filter { it.trigger != "back" }
        forwardTransitions.mapNotNull { transition ->
          val fromPos = positionByName[transition.fromScreen]
          val toPos = positionByName[transition.toScreen]
          if (fromPos != null && toPos != null) {
            EdgeHitZone(
              transitionId = transition.id,
              startX = fromPos.x + nodeWidthPx, // Right edge
              startY = fromPos.y + nodeHeightPx / 2, // Center Y
              endX = toPos.x, // Left edge
              endY = toPos.y + nodeHeightPx / 2, // Center Y
            )
          } else null
        }
      }

    NavigationCanvasLayout(
      density,
      nodePositions,
      screenById,
      screenByName,
      positionByName,
      nodeWidthPx,
      nodeHeightPx,
      edgeHitZones,
    )
  }

internal fun distanceToSegment(
  point: androidx.compose.ui.geometry.Offset,
  start: androidx.compose.ui.geometry.Offset,
  end: androidx.compose.ui.geometry.Offset,
): Float {
  val px = point.x
  val py = point.y
  val x1 = start.x
  val y1 = start.y
  val x2 = end.x
  val y2 = end.y

  val dx = x2 - x1
  val dy = y2 - y1
  val lengthSquared = dx * dx + dy * dy

  if (lengthSquared == 0f) {
    // Segment is a point
    return kotlin.math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1))
  }

  // Project point onto segment, clamped to [0, 1]
  val t = maxOf(0f, minOf(1f, ((px - x1) * dx + (py - y1) * dy) / lengthSquared))

  // Find projection point
  val projX = x1 + t * dx
  val projY = y1 + t * dy

  return kotlin.math.sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY))
}
