@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch

@Composable
internal fun CanvasHoverEffect(context: NavigationCanvasContext) {
  with(context) {
    LaunchedEffect(mouseX, mouseY, edgeHitZones, scale, offsetX, offsetY, hoveredScreenName) {
      if (hoveredScreenName != null) {
        // Screen hover takes precedence - clear edge hover
        if (hoveredTransitionId != null) {
          hoveredTransitionId = null
        }
      } else {
        val hitThreshold = 15f // Pixels from edge line to count as hit
        val detectedEdge =
          edgeHitZones
            .find { zone ->
              // Transform edge points to screen coordinates
              val sx = zone.startX * scale + offsetX
              val sy = zone.startY * scale + offsetY
              val ex = zone.endX * scale + offsetX
              val ey = zone.endY * scale + offsetY
              distanceToSegment(
                androidx.compose.ui.geometry.Offset(mouseX, mouseY),
                androidx.compose.ui.geometry.Offset(sx, sy),
                androidx.compose.ui.geometry.Offset(ex, ey),
              ) < hitThreshold
            }
            ?.transitionId

        if (detectedEdge != hoveredTransitionId) {
          hoveredTransitionId = detectedEdge
        }
      }
    }
  }
}

@Composable
internal fun CanvasObservedFocusEffect(context: NavigationCanvasContext) {
  with(context) {
    LaunchedEffect(fogModeEnabled, currentObservedScreen) {
      if (fogModeEnabled && currentObservedScreen != null) {
        focusedScreenName = currentObservedScreen
        hoveredScreenName = currentObservedScreen
      } else if (!fogModeEnabled) {
        // Clear auto-set hover when fog is turned off
        if (hoveredScreenName == focusedScreenName) {
          hoveredScreenName = null
        }
      }
    }
  }
}

@Composable
internal fun CanvasInitialFitEffect(
  context: NavigationCanvasContext,
  viewportWidth: Float,
  viewportHeight: Float,
) {
  with(context) {
    LaunchedEffect(viewportWidth, viewportHeight, nodePositions) {
      val hasViewport = viewportWidth > 0 && viewportHeight > 0
      val fitReady = nodePositions.isNotEmpty() && hasViewport

      if (!hasInitialFit && externalHighlightedScreens.isEmpty() && fitReady) {
        // Compute bounding box of ALL screens
        val minX = nodePositions.minOf { it.x }
        val maxX = nodePositions.maxOf { it.x } + nodeWidthPx
        val minY = nodePositions.minOf { it.y }
        val maxY = nodePositions.maxOf { it.y } + nodeHeightPx

        // Add padding
        val padding = 60f
        val boundsWidth = maxX - minX + padding * 2
        val boundsHeight = maxY - minY + padding * 2
        val centerX = (minX + maxX) / 2
        val centerY = (minY + maxY) / 2

        // Calculate scale to fit all nodes in viewport
        val scaleX = viewportWidth / boundsWidth
        val scaleY = viewportHeight / boundsHeight
        val newScale = minOf(scaleX, scaleY, 1.5f).coerceIn(0.2f, 1.5f)

        // Center the graph in viewport
        val newOffsetX = viewportWidth / 2 - centerX * newScale
        val newOffsetY = viewportHeight / 2 - centerY * newScale

        scale = newScale
        offsetX = newOffsetX
        offsetY = newOffsetY
        animatedScale.snapTo(newScale)
        animatedOffsetX.snapTo(newOffsetX)
        animatedOffsetY.snapTo(newOffsetY)
        hasInitialFit = true
      }
    }
  }
}

@Composable
internal fun CanvasFitTriggerEffect(
  context: NavigationCanvasContext,
  viewportWidth: Float,
  viewportHeight: Float,
) {
  with(context) {
    LaunchedEffect(fitToViewTrigger) {
      val hasViewport = viewportWidth > 0 && viewportHeight > 0
      val fitReady = nodePositions.isNotEmpty() && hasViewport

      if (fitToViewTrigger > 0 && fitReady) {
        val minX = nodePositions.minOf { it.x }
        val maxX = nodePositions.maxOf { it.x } + nodeWidthPx
        val minY = nodePositions.minOf { it.y }
        val maxY = nodePositions.maxOf { it.y } + nodeHeightPx

        val padding = 60f
        val boundsWidth = maxX - minX + padding * 2
        val boundsHeight = maxY - minY + padding * 2
        val centerX = (minX + maxX) / 2
        val centerY = (minY + maxY) / 2

        val scaleX = viewportWidth / boundsWidth
        val scaleY = viewportHeight / boundsHeight
        val newScale = minOf(scaleX, scaleY, 1.5f).coerceIn(0.2f, 1.5f)

        val newOffsetX = viewportWidth / 2 - centerX * newScale
        val newOffsetY = viewportHeight / 2 - centerY * newScale

        launch { animatedScale.animateTo(newScale, tween(350, easing = FastOutSlowInEasing)) }
        launch { animatedOffsetX.animateTo(newOffsetX, tween(350, easing = FastOutSlowInEasing)) }
        launch { animatedOffsetY.animateTo(newOffsetY, tween(350, easing = FastOutSlowInEasing)) }
      }
    }
  }
}

@Composable
internal fun CanvasHighlightPanEffect(
  context: NavigationCanvasContext,
  viewportWidth: Float,
  viewportHeight: Float,
) {
  with(context) {
    LaunchedEffect(externalHighlightedScreens, viewportWidth, viewportHeight) {
      if (
        externalHighlightedScreens.isNotEmpty() &&
          externalHighlightedScreens != lastAutoPannedScreens
      ) {
        // Compute bounding box of highlighted screens
        val highlightedPositions = externalHighlightedScreens.mapNotNull { screenName ->
          positionByName[screenName]
        }
        if (highlightedPositions.isNotEmpty() && viewportWidth > 0 && viewportHeight > 0) {
          val minX = highlightedPositions.minOf { it.x }
          val maxX = highlightedPositions.maxOf { it.x } + nodeWidthPx
          val minY = highlightedPositions.minOf { it.y }
          val maxY = highlightedPositions.maxOf { it.y } + nodeHeightPx

          // Add padding
          val padding = 80f
          val boundsWidth = maxX - minX + padding * 2
          val boundsHeight = maxY - minY + padding * 2
          val centerX = (minX + maxX) / 2
          val centerY = (minY + maxY) / 2

          // Calculate scale to fit bounds in viewport (with some margin)
          val scaleX = viewportWidth / boundsWidth
          val scaleY = viewportHeight / boundsHeight
          val newScale = minOf(scaleX, scaleY, 1.5f).coerceIn(0.3f, 1.5f)

          // Center the bounds in viewport
          val newOffsetX = viewportWidth / 2 - centerX * newScale
          val newOffsetY = viewportHeight / 2 - centerY * newScale

          // Animate to new position smoothly
          launch { animatedScale.animateTo(newScale, tween(350, easing = FastOutSlowInEasing)) }
          launch {
            animatedOffsetX.animateTo(newOffsetX, tween(350, easing = FastOutSlowInEasing))
          }
          launch {
            animatedOffsetY.animateTo(newOffsetY, tween(350, easing = FastOutSlowInEasing))
          }
          lastAutoPannedScreens = externalHighlightedScreens
        }
      } else if (externalHighlightedScreens.isEmpty() && lastAutoPannedScreens.isNotEmpty()) {
        lastAutoPannedScreens = emptyList()
      }
    }
  }
}

@Composable
internal fun CanvasFogFocusEffect(
  context: NavigationCanvasContext,
  viewportWidth: Float,
  viewportHeight: Float,
) {
  with(context) {
    LaunchedEffect(
      focusedScreenName,
      fogModeEnabled,
      viewportWidth,
      viewportHeight,
      nodePositions,
    ) {
      val hasViewport = viewportWidth > 0 && viewportHeight > 0

      if (fogModeEnabled && focusedScreenName != null && hasViewport) {
        val targetPos = positionByName[focusedScreenName]
        if (targetPos != null) {
          val newScale = 1.5f
          val targetOffsetX = viewportWidth / 2 - (targetPos.x + nodeWidthPx / 2) * newScale
          val targetOffsetY = viewportHeight / 2 - (targetPos.y + nodeHeightPx / 2) * newScale

          launch { animatedScale.animateTo(newScale, tween(350, easing = FastOutSlowInEasing)) }
          launch {
            animatedOffsetX.animateTo(targetOffsetX, tween(350, easing = FastOutSlowInEasing))
          }
          launch {
            animatedOffsetY.animateTo(targetOffsetY, tween(350, easing = FastOutSlowInEasing))
          }
        }
      }
    }
  }
}

@Composable
internal fun CanvasAnimationSyncEffect(context: NavigationCanvasContext) {
  with(context) {
    LaunchedEffect(animatedOffsetX.value, animatedOffsetY.value, animatedScale.value) {
      scale = animatedScale.value
      offsetX = animatedOffsetX.value
      offsetY = animatedOffsetY.value
    }
  }
}
