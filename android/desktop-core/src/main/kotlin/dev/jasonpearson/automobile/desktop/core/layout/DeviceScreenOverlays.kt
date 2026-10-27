@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke

internal fun androidx.compose.ui.graphics.drawscope.ContentDrawScope.drawDeviceScreenOverlays(
  options: DeviceScreenOptions,
  scene: DeviceScreenScene,
  layout: DeviceScreenLayout,
  flashAlpha: Float,
) {

  drawContent()
  drawHoveredDeviceElement(options, scene, layout)
  drawSelectedDeviceElement(scene, layout)
  drawFlashedDeviceElement(scene, layout, flashAlpha)
  drawDeviceTapIssues(options, scene, layout)
  drawDeviceTouchFeedback(scene)
}

internal fun androidx.compose.ui.graphics.drawscope.DrawScope.deviceOverlayRect(
  layout: DeviceScreenLayout,
  bounds: ElementBounds,
): FloatArray {
  val boundsToFrameScale =
    if (layout.rotatedRootWidth > 0) size.width / layout.rotatedRootWidth.toFloat() else 1f
  val t =
    transformBoundsForRotation(
      bounds,
      layout.boundsRotation,
      layout.rootBoundsWidth,
      layout.rootBoundsHeight,
    )
  return floatArrayOf(
    t[0] * boundsToFrameScale,
    t[1] * boundsToFrameScale,
    t[2] * boundsToFrameScale,
    t[3] * boundsToFrameScale,
  )
}

internal fun androidx.compose.ui.graphics.drawscope.DrawScope.drawHoveredDeviceElement(
  options: DeviceScreenOptions,
  scene: DeviceScreenScene,
  layout: DeviceScreenLayout,
) {
  with(options) {
    with(scene) {
      with(highlights) {
        if (hoveredElement != null && hoveredElement.id != selectedElementId) {
          val r = deviceOverlayRect(layout, hoveredElement.bounds)
          drawRect(
            color = Color.Gray.copy(alpha = 0.5f),
            topLeft = Offset(r[0], r[1]),
            size = Size(r[2], r[3]),
            style = Stroke(width = 2f),
          )
        }
      }
    }
  }
}

internal fun androidx.compose.ui.graphics.drawscope.DrawScope.drawSelectedDeviceElement(
  scene: DeviceScreenScene,
  layout: DeviceScreenLayout,
) {
  with(scene) {
    with(highlights) {
      if (selectedElement != null) {
        val r = deviceOverlayRect(layout, selectedElement.bounds)
        drawRect(
          color = Color(0xFF2196F3),
          topLeft = Offset(r[0], r[1]),
          size = Size(r[2], r[3]),
          style = Stroke(width = 3f),
        )
        // Fill with semi-transparent blue
        drawRect(
          color = Color(0xFF2196F3).copy(alpha = 0.1f),
          topLeft = Offset(r[0], r[1]),
          size = Size(r[2], r[3]),
        )
      }
    }
  }
}

internal fun androidx.compose.ui.graphics.drawscope.DrawScope.drawFlashedDeviceElement(
  scene: DeviceScreenScene,
  layout: DeviceScreenLayout,
  flashAlpha: Float,
) {
  with(scene) {
    with(highlights) {
      if (flashElement != null && flashAlpha > 0f) {
        val r = deviceOverlayRect(layout, flashElement.bounds)
        // Draw bright yellow border
        drawRect(
          color = Color(0xFFFFD700).copy(alpha = flashAlpha),
          topLeft = Offset(r[0], r[1]),
          size = Size(r[2], r[3]),
          style = Stroke(width = 4f),
        )
        // Fill with semi-transparent yellow
        drawRect(
          color = Color(0xFFFFD700).copy(alpha = flashAlpha * 0.3f),
          topLeft = Offset(r[0], r[1]),
          size = Size(r[2], r[3]),
        )
      }
    }
  }
}

internal fun androidx.compose.ui.graphics.drawscope.DrawScope.drawDeviceTapIssues(
  options: DeviceScreenOptions,
  scene: DeviceScreenScene,
  layout: DeviceScreenLayout,
) {
  if (!options.showTapTargetIssues) return
  for (element in scene.highlights.nonCompliantElements) {
    val r = deviceOverlayRect(layout, element.bounds)
    // Draw orange border
    drawRect(
      color = Color(0xFFFF6B00),
      topLeft = Offset(r[0], r[1]),
      size = Size(r[2], r[3]),
      style = Stroke(width = 2f),
    )
    // Fill with semi-transparent orange
    drawRect(
      color = Color(0xFFFF6B00).copy(alpha = 0.15f),
      topLeft = Offset(r[0], r[1]),
      size = Size(r[2], r[3]),
    )
  }
}

internal fun androidx.compose.ui.graphics.drawscope.DrawScope.drawDeviceTouchFeedback(
  scene: DeviceScreenScene,
) {
  with(scene) {
    with(highlights) {
      for (feedback in activeTouchFeedback) {
        val center = touchFeedbackCenter(feedback.marker, size.width, size.height) ?: continue
        val alpha = (1f - feedback.progress).coerceIn(0f, 1f)
        val radius = TOUCH_PULSE_BASE_RADIUS_PX * (0.7f + 0.6f * feedback.progress)
        val pulseColor = Color(0xFF2196F3)
        drawCircle(
          color = pulseColor.copy(alpha = alpha * 0.25f),
          radius = radius,
          center = Offset(center.x, center.y),
        )
        drawCircle(
          color = pulseColor.copy(alpha = alpha),
          radius = radius,
          center = Offset(center.x, center.y),
          style = Stroke(width = 2f),
        )
      }
    }
  }
}

/**
 * Transform element bounds from the original (unrotated) hierarchy coordinate system to the rotated
 * display coordinate system.
 *
 * @param bounds Original bounds in hierarchy coordinates
 * @param rotation Device rotation (0=portrait, 1=landscape 270°CW, 2=reverse, 3=landscape 90°CW)
 * @param rootWidth Width of the root element in hierarchy coordinates (unrotated)
 * @param rootHeight Height of the root element in hierarchy coordinates (unrotated)
 * @return Transformed bounds as (left, top, width, height) in rotated coordinates
 */
internal fun transformBoundsForRotation(
  bounds: ElementBounds,
  rotation: Int,
  rootWidth: Int,
  rootHeight: Int,
): FloatArray {
  // Returns [left, top, width, height] in the rotated coordinate space
  return when (rotation) {
    1 -> {
      // Landscape (home button on right): rotate 270° CW
      // Original (x, y) -> rotated (y, rootWidth - x - width)
      floatArrayOf(
        bounds.top.toFloat(),
        (rootWidth - bounds.right).toFloat(),
        bounds.height.toFloat(),
        bounds.width.toFloat(),
      )
    }
    2 -> {
      // Reverse portrait: rotate 180°
      floatArrayOf(
        (rootWidth - bounds.right).toFloat(),
        (rootHeight - bounds.bottom).toFloat(),
        bounds.width.toFloat(),
        bounds.height.toFloat(),
      )
    }
    3 -> {
      // Reverse landscape (home button on left): rotate 90° CW
      // Original (x, y) -> rotated (rootHeight - y - height, x)
      floatArrayOf(
        (rootHeight - bounds.bottom).toFloat(),
        bounds.left.toFloat(),
        bounds.height.toFloat(),
        bounds.width.toFloat(),
      )
    }
    else -> {
      // No rotation
      floatArrayOf(
        bounds.left.toFloat(),
        bounds.top.toFloat(),
        bounds.width.toFloat(),
        bounds.height.toFloat(),
      )
    }
  }
}

/**
 * Base radius, in frame pixels at zoom 1.0, of the transient control-tap feedback pulse
 * (issue #3352). Placed via `touchFeedbackCenter` (the canonical mapper through the marker's
 * captured bounds, #4546), and grown further as the pulse fades.
 */
private const val TOUCH_PULSE_BASE_RADIUS_PX = 12f
