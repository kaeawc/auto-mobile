@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke

internal data class NavigationEdgePoint(val x: Float, val y: Float, val side: String)

internal data class NavigationNodeEdgePoints(
  val left: NavigationEdgePoint,
  val right: NavigationEdgePoint,
  val top: NavigationEdgePoint,
  val bottom: NavigationEdgePoint,
)

internal data class NavigationEdgeGeometry(
  val from: NavigationEdgePoint,
  val to: NavigationEdgePoint,
  val minimumDistance: Float,
)

internal fun androidx.compose.ui.graphics.drawscope.DrawScope.drawNavigationEdges(
  context: NavigationCanvasContext,
) {
  with(context) {
    val strokeWidth = 4f * scale
    transitions
      .filter { it.trigger != "back" }
      .forEach { transition ->
        val fromPos = positionByName[transition.fromScreen]
        val toPos = positionByName[transition.toScreen]
        if (fromPos != null && toPos != null) {
          val geometry =
            selectNavigationEdgePoints(
              nodeEdgePoints(fromPos, context),
              nodeEdgePoints(toPos, context),
            )
          // Determine edge color based on highlight state
          val isHighlighted = transition.id in highlightedTransitions
          val hasAnyHighlight =
            highlightedScreens.isNotEmpty() || highlightedTransitions.isNotEmpty()
          val baseEdgeColor =
            when {
              isHighlighted -> highlightedArrowColor
              hasAnyHighlight -> dimmedArrowColor
              else -> arrowColor
            }
          // Fade transitions reached only historically / by another build or device
          // (#4985).
          val provenanceAlpha = ProvenanceOpacity.alphaFor(transition.provenance, activeContext)
          val edgeColor = baseEdgeColor.copy(alpha = baseEdgeColor.alpha * provenanceAlpha)
          val edgeStrokeWidth = if (isHighlighted) strokeWidth * 1.5f else strokeWidth

          drawPath(
            path = geometry.path(),
            color = edgeColor,
            style = Stroke(width = edgeStrokeWidth, cap = StrokeCap.Round),
          )
        }
      }
  }
}

private fun nodeEdgePoints(
  position: NodePosition,
  context: NavigationCanvasContext,
): NavigationNodeEdgePoints =
  with(context) {
    NavigationNodeEdgePoints(
      left =
        NavigationEdgePoint(
          position.x * scale + offsetX,
          (position.y + nodeHeightPx / 2) * scale + offsetY,
          "left",
        ),
      right =
        NavigationEdgePoint(
          (position.x + nodeWidthPx) * scale + offsetX,
          (position.y + nodeHeightPx / 2) * scale + offsetY,
          "right",
        ),
      top =
        NavigationEdgePoint(
          (position.x + nodeWidthPx / 2) * scale + offsetX,
          position.y * scale + offsetY,
          "top",
        ),
      bottom =
        NavigationEdgePoint(
          (position.x + nodeWidthPx / 2) * scale + offsetX,
          (position.y + nodeHeightPx) * scale + offsetY,
          "bottom",
        ),
    )
  }

private fun selectNavigationEdgePoints(
  from: NavigationNodeEdgePoints,
  to: NavigationNodeEdgePoints,
): NavigationEdgeGeometry {
  val fromPoints = listOf(from.right, from.bottom, from.top, from.left)
  val toPoints = listOf(to.left, to.top, to.bottom, to.right)
  var minDist = Float.MAX_VALUE
  for (fp in fromPoints) for (tp in toPoints) {
    val distance = edgePointDistance(fp, tp)
    if (distance < minDist) minDist = distance
  }
  val margin = minDist * 0.15f
  var bestFrom = from.right
  var bestTo = to.left
  var bestPriority = Int.MAX_VALUE
  for (fp in fromPoints) for (tp in toPoints) {
    val distance = edgePointDistance(fp, tp)
    if (distance <= minDist + margin) {
      val priority = sidePriority(fp.side, tp.side)
      if (priority < bestPriority) {
        bestPriority = priority
        bestFrom = fp
        bestTo = tp
      }
    }
  }
  return NavigationEdgeGeometry(bestFrom, bestTo, minDist)
}

private fun edgePointDistance(p1: NavigationEdgePoint, p2: NavigationEdgePoint): Float =
  kotlin.math.sqrt((p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y))

private fun sidePriority(fromSide: String, toSide: String): Int {
  val fromPriority =
    when (fromSide) {
      "right" -> 0
      "bottom" -> 1
      "top" -> 2
      else -> 3
    }
  val toPriority =
    when (toSide) {
      "left" -> 0
      "top" -> 1
      "bottom" -> 2
      else -> 3
    }
  return fromPriority * 4 + toPriority
}

private fun NavigationEdgeGeometry.path(): Path {
  val bestFrom = from
  val bestTo = to
  val minDist = minimumDistance
  val startX = from.x
  val startY = from.y
  val endX = to.x
  val endY = to.y
  // Build smooth curved path using cubic bezier
  val path = Path()
  path.moveTo(startX, startY)

  // Control point offset - extends perpendicular to the edge
  val curveStrength = minDist * 0.4f

  // Control point 1: extends outward from start point based on which side
  val ctrl1X =
    when (bestFrom.side) {
      "left" -> startX - curveStrength
      "right" -> startX + curveStrength
      else -> startX
    }
  val ctrl1Y =
    when (bestFrom.side) {
      "top" -> startY - curveStrength
      "bottom" -> startY + curveStrength
      else -> startY
    }

  // Control point 2: extends outward from end point based on which side
  val ctrl2X =
    when (bestTo.side) {
      "left" -> endX - curveStrength
      "right" -> endX + curveStrength
      else -> endX
    }
  val ctrl2Y =
    when (bestTo.side) {
      "top" -> endY - curveStrength
      "bottom" -> endY + curveStrength
      else -> endY
    }

  path.cubicTo(ctrl1X, ctrl1Y, ctrl2X, ctrl2Y, endX, endY)

  return path
}
