@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenCoordinateMapper

internal fun DeviceScreenMemory.zoomAroundPoint(newScale: Float, pivotX: Float, pivotY: Float) {

  val oldScale = scale
  val contentX = (pivotX - offsetX) / oldScale
  val contentY = (pivotY - offsetY) / oldScale
  scale = newScale
  offsetX = pivotX - contentX * newScale
  offsetY = pivotY - contentY * newScale
}

internal fun DeviceScreenMemory.zoomAroundCenter(layout: DeviceScreenLayout, newScale: Float) {
  zoomAroundPoint(newScale, layout.viewportWidth / 2, layout.viewportHeight / 2)
}

@Composable
internal fun DeviceScreenZoomControls(
  memory: DeviceScreenMemory,
  layout: DeviceScreenLayout,
  modifier: Modifier,
) {
  with(memory) {
    with(layout) {
      ZoomControls(
        scale = scale,
        onZoomIn = { zoomAroundCenter(layout, (scale * 1.2f).coerceAtMost(5f)) },
        onZoomOut = { zoomAroundCenter(layout, (scale / 1.2f).coerceAtLeast(0.1f)) },
        onFitToScreen = {
          // Calculate scale to fit and center the frame (shared Compose-free math).
          val fitScale =
            DeviceScreenCoordinateMapper.fitScale(
              frameWidthPx = frameWidthPx,
              frameHeightPx = frameHeightPx,
              viewportWidth = viewportWidth,
              viewportHeight = viewportHeight,
              padding = padding,
            )
          scale = fitScale
          offsetX = (viewportWidth - frameWidthPx * scale) / 2
          offsetY = (viewportHeight - frameHeightPx * scale) / 2
        },
        modifier = modifier,
      )
    }
  }
}

@Composable
internal fun ZoomControls(
  scale: Float,
  onZoomIn: () -> Unit,
  onZoomOut: () -> Unit,
  onFitToScreen: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors

  Column(
    modifier =
      modifier
        .background(colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(8.dp))
        .padding(4.dp),
    verticalArrangement = Arrangement.spacedBy(2.dp),
  ) {
    ZoomButton("+", onClick = onZoomIn)
    ZoomButton("-", onClick = onZoomOut)
    ZoomButton("\u2922", onClick = onFitToScreen) // Fit icon

    Text(
      "${(scale * 100).toInt()}%",
      fontSize = 9.sp,
      maxLines = 1,
      softWrap = false,
      color = colors.text.normal.copy(alpha = 0.5f),
      modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 2.dp),
    )
  }
}

@Composable
internal fun ZoomButton(label: String, onClick: () -> Unit) {
  val colors = SharedTheme.globalColors

  Box(
    modifier =
      Modifier.size(28.dp)
        .background(colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(4.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand),
    contentAlignment = Alignment.Center,
  ) {
    Text(label, fontSize = 14.sp)
  }
}
