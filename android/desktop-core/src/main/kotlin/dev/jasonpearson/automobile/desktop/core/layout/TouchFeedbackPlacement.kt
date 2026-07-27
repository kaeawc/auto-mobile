package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.domain.DeviceScreenCoordinateMapper
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenGeometry
import dev.jasonpearson.automobile.desktop.domain.TouchFeedbackMarker
import dev.jasonpearson.automobile.desktop.domain.ViewportPoint

/**
 * The center, in frame pixels, at which to draw the touch pulse for [marker] on a frame canvas of
 * [frameWidthPx] x [frameHeightPx] (issues #3352, #4546).
 *
 * Routes through the canonical [DeviceScreenCoordinateMapper.deviceToViewport] rather than a
 * private inverse transform, so pulse placement can never drift from the mapper the tap itself was
 * mapped with. The geometry is built from the marker's OWN captured snapshot bounds — not the live
 * device dimensions — so the pulse lands where the tap mapped and does not move if a resolution or
 * rotation change arrives mid-fade. The pulse is drawn inside the frame's own draw scope (the
 * zoom/pan `graphicsLayer` already transforms the canvas), so scale is 1 and pan is 0 here.
 *
 * Returns `null` for a degenerate non-positive captured width: such a snapshot has no addressable
 * pixel to place a pulse at, so no pulse is drawn.
 */
internal fun touchFeedbackCenter(
  marker: TouchFeedbackMarker,
  frameWidthPx: Float,
  frameHeightPx: Float,
): ViewportPoint? {
  if (marker.deviceWidth <= 0) return null
  val geometry =
    DeviceScreenGeometry(
      frameWidthPx = frameWidthPx,
      frameHeightPx = frameHeightPx,
      scale = 1f,
      offsetX = 0f,
      offsetY = 0f,
      deviceWidth = marker.deviceWidth,
      deviceHeight = marker.deviceHeight,
    )
  return DeviceScreenCoordinateMapper.deviceToViewport(marker.x, marker.y, geometry)
}
