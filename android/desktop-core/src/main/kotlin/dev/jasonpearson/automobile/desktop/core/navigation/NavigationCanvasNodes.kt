@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

@Composable
internal fun CanvasNodes(context: NavigationCanvasContext) {
  context.nodePositions.forEach { pos -> CanvasNode(context, pos) }
}

@Composable
private fun CanvasNode(context: NavigationCanvasContext, pos: NodePosition) {
  with(context) {
    val screen = screenByName[pos.screenId] ?: return

    val hasAnyHighlight = highlightedScreens.isNotEmpty() || highlightedTransitions.isNotEmpty()

    Box(
      modifier =
        Modifier.offset {
            IntOffset(
              (pos.x * scale + offsetX).roundToInt(),
              (pos.y * scale + offsetY).roundToInt(),
            )
          }
          .graphicsLayer {
            scaleX = scale
            scaleY = scale
            transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0f, 0f)
          },
    ) {
      ScreenNodeCard(
        dev.jasonpearson.automobile.desktop.core.navigation.ScreenNodeCardOptions(
          screen = screen,
          isHovered = screen.name == highlightState.hoveredScreen,
          isSource = screen.name in highlightState.sourceScreens,
          isTarget = screen.name in highlightState.targetScreens,
          isInTestFlow = screen.name in highlightState.testFlowScreens,
          isCurrentReplayStep = screen.name == currentReplayScreen,
          isFogFocused = fogModeEnabled && screen.name == focusedScreenName,
          isDimmed = hasAnyHighlight && screen.name !in highlightedScreens,
          provenanceAlpha = ProvenanceOpacity.alphaFor(screen.provenance, activeContext),
          provenanceDescription =
            ProvenanceOpacity.contentDescription(
              screen.name,
              screen.provenance,
              activeContext,
            ),
          onClick = {
            onScreenSelected(screen.id)
          },
          onHoverChange = { isHovered ->
            hoveredScreenName = if (isHovered) screen.name else null
          },
          screenshotLoader = screenshotLoader,
          ioDispatcher = ioDispatcher,
        ),
      )
    }
  }
}

@Composable
internal fun CanvasFogOverlay(context: NavigationCanvasContext) {
  with(context) {
    if (fogModeEnabled && focusedScreenName != null) {
      val focusPos = positionByName[focusedScreenName]
      if (focusPos != null) {
        val centerX = (focusPos.x + nodeWidthPx / 2) * scale + offsetX
        val centerY = (focusPos.y + nodeHeightPx / 2) * scale + offsetY
        val surfaceColor = colors.text.normal.copy(alpha = 0f)
        val fogColor = MaterialTheme.colorScheme.onSurface

        Canvas(modifier = Modifier.fillMaxSize().zIndex(1f)) {
          val maxRadius = maxOf(size.width, size.height) * 0.625f

          drawRect(
            brush =
              Brush.radialGradient(
                colorStops =
                  arrayOf(
                    0.0f to Color.Transparent,
                    0.3f to fogColor.copy(alpha = 0.05f),
                    0.6f to fogColor.copy(alpha = 0.20f),
                    1.0f to fogColor.copy(alpha = 0.50f),
                  ),
                center = androidx.compose.ui.geometry.Offset(centerX, centerY),
                radius = maxRadius,
              ),
            size = size,
          )
        }
      }
    }
  }
}

@Composable
internal fun BoxScope.CanvasFogToggle(context: NavigationCanvasContext) {
  with(context) {
    val fogEnabled = currentObservedScreen != null
    Row(
      modifier =
        Modifier.align(Alignment.TopStart)
          .zIndex(2f)
          .padding(start = 12.dp, top = 44.dp)
          .graphicsLayer { alpha = if (fogEnabled) 1f else 0.4f }
          .background(colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(8.dp))
          .padding(8.dp)
          .semantics {
            contentDescription = if (fogEnabled) "Fog focus available" else "Fog focus unavailable"
          },
      horizontalArrangement = Arrangement.spacedBy(16.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Fog", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.7f))
        Spacer(Modifier.width(4.dp))
        ToggleSwitch(
          checked = fogModeEnabled && fogEnabled,
          onCheckedChange = { if (fogEnabled) onFogModeToggled(it) },
        )
      }
    }
  }
}

@Composable
internal fun BoxScope.CanvasZoomControls(
  context: NavigationCanvasContext,
  viewportWidth: Float,
  viewportHeight: Float,
) {
  with(context) {
    fun zoomAroundCenter(newScale: Float) {
      zoomAroundPoint(newScale, viewportWidth / 2, viewportHeight / 2)
    }
    ZoomControls(
      scale = scale,
      onZoomIn = {
        zoomAroundCenter((scale * 1.2f).coerceAtMost(5f))
        animationScope.launch {
          animatedScale.snapTo(scale)
          animatedOffsetX.snapTo(offsetX)
          animatedOffsetY.snapTo(offsetY)
        }
      },
      onZoomOut = {
        zoomAroundCenter((scale / 1.2f).coerceAtLeast(0.05f))
        animationScope.launch {
          animatedScale.snapTo(scale)
          animatedOffsetX.snapTo(offsetX)
          animatedOffsetY.snapTo(offsetY)
        }
      },
      onReset = {
        scale = 1f
        offsetX = 0f
        offsetY = 0f
        animationScope.launch {
          animatedScale.snapTo(1f)
          animatedOffsetX.snapTo(0f)
          animatedOffsetY.snapTo(0f)
        }
      },
      modifier = Modifier.align(Alignment.BottomEnd).zIndex(2f).padding(16.dp),
    )
  }
}
