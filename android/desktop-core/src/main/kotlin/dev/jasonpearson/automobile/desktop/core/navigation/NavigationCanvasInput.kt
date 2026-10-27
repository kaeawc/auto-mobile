@file:OptIn(ExperimentalFoundationApi::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.navigation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.ui.input.pointer.pointerInput
import kotlinx.coroutines.launch

internal fun NavigationCanvasContext.zoomAroundPoint(
  newScale: Float,
  pivotX: Float,
  pivotY: Float,
) {
  val oldScale = scale
  // Find the content point at the pivot
  val contentX = (pivotX - offsetX) / oldScale
  val contentY = (pivotY - offsetY) / oldScale
  // Update scale
  scale = newScale
  // Adjust offset so the same content point stays at pivot
  offsetX = pivotX - contentX * newScale
  offsetY = pivotY - contentY * newScale
}

internal fun canvasInputModifier(context: NavigationCanvasContext): Modifier =
  with(context) {
    Modifier.fillMaxSize()
      .pointerInput(Unit) {
        detectDragGestures { change, dragAmount ->
          change.consume()
          offsetX += dragAmount.x
          offsetY += dragAmount.y
          // Snap animatables to prevent conflicts with manual drag
          animationScope.launch {
            animatedOffsetX.snapTo(offsetX)
            animatedOffsetY.snapTo(offsetY)
            animatedScale.snapTo(scale)
          }
        }
      }
      .onPointerEvent(PointerEventType.Move) { event ->
        val pos = event.changes.firstOrNull()?.position
        if (pos != null) {
          mouseX = pos.x
          mouseY = pos.y
        }
      }
      .onPointerEvent(PointerEventType.Exit) {
        // Deselect all elements when mouse leaves canvas
        hoveredScreenName = null
        hoveredTransitionId = null
      }
      .onPointerEvent(PointerEventType.Scroll) { event ->
        // Only allow scroll-to-zoom when Cmd (macOS) / Ctrl (other) is held
        if (!event.isZoomModifierPressed()) return@onPointerEvent
        val change = event.changes.firstOrNull() ?: return@onPointerEvent
        val scrollDelta = change.scrollDelta.y
        if (scrollDelta != 0f) {
          // 10x less sensitive: smaller zoom factor per scroll tick
          val zoomFactor = if (scrollDelta > 0) 0.99f else 1.01f
          val newScale = (scale * zoomFactor).coerceIn(0.05f, 5f)
          // Zoom around cursor position
          zoomAroundPoint(newScale, change.position.x, change.position.y)
          // Snap animatables to prevent conflicts with manual zoom
          animationScope.launch {
            animatedScale.snapTo(scale)
            animatedOffsetX.snapTo(offsetX)
            animatedOffsetY.snapTo(offsetY)
          }
        }
      }
      .drawBehind { drawNavigationEdges(context) }
  }
