package dev.jasonpearson.automobile.desktop.domain

import kotlin.math.roundToInt

/**
 * Which interaction contract a device-screen view honors.
 *
 * This is a pure model type (no Compose dependency) so any daemon client — the desktop inspector,
 * the IDE plugin, or a third-party client — can reason about the mode without pulling in a UI
 * toolkit. The default is always [Inspector] so existing consumers keep today's behavior with no
 * source change.
 */
public enum class DeviceScreenControlMode {
  /**
   * A click selects the deepest element under the cursor and hover highlights elements. This is the
   * historical layout-inspector behavior and the default.
   */
  Inspector,

  /**
   * A click maps to a device coordinate a caller can forward to the typed daemon input helpers as a
   * tap, and a drag maps to a start/end pair a caller can forward as a swipe (see
   * [DeviceDragGesturePolicy] for when a drag counts as one). Selecting and hover-highlighting are
   * suppressed, and viewport pan moves onto the zoom modifier so a plain drag is free to mean a
   * device swipe. Wiring the coordinates to the daemon is the caller's responsibility; this module
   * never sends input.
   */
  Control,
}

/**
 * A point in viewport coordinates: the pixel space of the on-screen canvas that renders the device
 * frame, origin at the viewport's top-left, before zoom/pan are removed.
 */
public data class ViewportPoint(val x: Float, val y: Float)

/**
 * A point in device coordinates: the same coordinate space as [ElementBounds] (Android device
 * pixels, or iOS logical points). [inBounds] reports whether the point falls inside the device
 * screen rectangle `[0, deviceWidth) x
 * [0, deviceHeight)`. Callers that must not act outside the screen (e.g. sending a tap) should reject when `!inBounds` or use [clampedTo].
 */
public data class DevicePoint(val x: Int, val y: Int, val inBounds: Boolean) {
  /**
   * Returns this point clamped to the last addressable pixel of a `width x height` device screen.
   * Use only when an out-of-bounds gesture must be pinned to the edge rather than dropped. The
   * clamped point is, by definition, inside a non-empty screen rect, so [inBounds] becomes true
   * whenever `width` and `height` are both positive; a zero-dimension screen has no addressable
   * pixel, so it stays false.
   */
  public fun clampedTo(width: Int, height: Int): DevicePoint {
    val cx = x.coerceIn(0, (width - 1).coerceAtLeast(0))
    val cy = y.coerceIn(0, (height - 1).coerceAtLeast(0))
    return DevicePoint(cx, cy, inBounds = width > 0 && height > 0)
  }
}

/** The fitted on-screen size, in viewport pixels, of the device frame at zoom scale 1.0. */
public data class FrameSize(val widthPx: Float, val heightPx: Float)

/**
 * A snapshot of how the device screenshot is laid out inside the viewport for one rendered frame. A
 * caller builds this once (from the current fit size, zoom [scale], pan offsets, and the device
 * coordinate-space dimensions) and hands it to [DeviceScreenCoordinateMapper] for every point
 * conversion, so a click-to-tap or drag-to-swipe path can map with a single call.
 *
 * @param frameWidthPx fitted frame width at scale 1.0 (from
 *   [DeviceScreenCoordinateMapper.fitToViewport]).
 * @param frameHeightPx fitted frame height at scale 1.0.
 * @param scale current zoom multiplier applied on top of the fitted frame.
 * @param offsetX current pan offset along x, in viewport pixels.
 * @param offsetY current pan offset along y, in viewport pixels.
 * @param deviceWidth width of the device coordinate space (root hierarchy bounds width, already
 *   rotation-aligned with the displayed screenshot).
 * @param deviceHeight height of the device coordinate space.
 */
public data class DeviceScreenGeometry(
  val frameWidthPx: Float,
  val frameHeightPx: Float,
  val scale: Float,
  val offsetX: Float,
  val offsetY: Float,
  val deviceWidth: Int,
  val deviceHeight: Int,
)

/**
 * Compose-free viewport <-> device coordinate mapping for a mirrored device screen.
 *
 * The rendering pipeline is: the raw screenshot is rotated so it aligns with the hierarchy
 * coordinate space (see [detectScreenshotRotation]); the aligned image is fitted into the viewport
 * preserving aspect ratio (see [fitToViewport]); then a uniform zoom [DeviceScreenGeometry.scale]
 * and pan offset are applied. Because the screenshot is pre-rotated to match the hierarchy, the
 * viewport<->device mapping itself is a plain scale + translate with no further rotation.
 *
 * Contract (documented for third-party clients in
 * `docs/design-docs/mcp/daemon/screen-control-mapping.md`):
 * - **Scale/pan:** device = round((viewport - offset) / scale * deviceWidth / frameWidthPx). The
 *   width-based scale is used for both axes because the frame is fitted to the device aspect ratio.
 * - **Rounding:** nearest integer, halves rounding up (Kotlin `roundToInt`).
 * - **Rotation:** handled up front by [detectScreenshotRotation] rotating the screenshot to the
 *   hierarchy orientation; the mapper takes already-aligned dimensions.
 * - **Out of bounds:** [viewportToDevice] never clamps. It returns the raw rounded coordinate with
 *   [DevicePoint.inBounds] = false when it falls outside `[0, deviceWidth) x
 *   [0, deviceHeight)`. Inspector hit-testing relies on this (an out-of-screen click resolves to no element); control callers should drop or [DevicePoint.clampedTo]
 *   such points.
 */
public object DeviceScreenCoordinateMapper {

  /** Default viewport inset (per side) reserved around the fitted device frame, in pixels. */
  public const val DEFAULT_PADDING: Float = 32f

  /** Fallback device aspect ratio (height / width) used when image width is unknown. */
  private const val FALLBACK_ASPECT_RATIO: Float = 2.16f

  /**
   * Detect the rotation needed to align a raw screenshot with the hierarchy coordinate space, by
   * comparing the screenshot's portrait/landscape orientation to the hierarchy root's.
   *
   * Screenshots can arrive in native pixel orientation (portrait) even when the device is
   * landscape, while hierarchy bounds are in display orientation. Returns a quarter-turn code:
   * - `0` — no rotation (orientations already agree).
   * - `1` — rotate 270 degrees clockwise (landscape image, portrait bounds).
   * - `3` — rotate 90 degrees clockwise (portrait image, landscape bounds).
   *
   * Returns `0` for any non-positive dimension. Code `2` (180 degrees) is never inferred from
   * orientation alone.
   */
  public fun detectScreenshotRotation(
    imageWidth: Int,
    imageHeight: Int,
    rootWidth: Int,
    rootHeight: Int,
  ): Int {
    if (imageWidth <= 0 || imageHeight <= 0 || rootWidth <= 0 || rootHeight <= 0) return 0
    val imageIsPortrait = imageHeight > imageWidth
    val boundsIsPortrait = rootHeight > rootWidth
    return when {
      imageIsPortrait && !boundsIsPortrait -> 3
      !imageIsPortrait && boundsIsPortrait -> 1
      else -> 0
    }
  }

  /**
   * Size the device frame so it fits inside the viewport (minus [padding] per side) while
   * preserving the image aspect ratio. Mirrors the inspector's fit math exactly. Uses
   * [FALLBACK_ASPECT_RATIO] when [imageWidth] is non-positive.
   */
  public fun fitToViewport(
    imageWidth: Int,
    imageHeight: Int,
    viewportWidth: Float,
    viewportHeight: Float,
    padding: Float = DEFAULT_PADDING,
  ): FrameSize {
    val deviceAspectRatio =
      if (imageWidth > 0) imageHeight.toFloat() / imageWidth.toFloat() else FALLBACK_ASPECT_RATIO
    val maxFrameWidth = (viewportWidth - padding * 2).coerceAtLeast(1f)
    val maxFrameHeight = (viewportHeight - padding * 2).coerceAtLeast(1f)
    return if (maxFrameWidth * deviceAspectRatio <= maxFrameHeight) {
      // Width-constrained.
      FrameSize(maxFrameWidth, maxFrameWidth * deviceAspectRatio)
    } else {
      // Height-constrained.
      FrameSize(maxFrameHeight / deviceAspectRatio, maxFrameHeight)
    }
  }

  /**
   * Compute the zoom scale that fits the already-fitted frame inside the viewport, matching the
   * inspector's initial-fit and "fit to screen" behavior: never scale beyond 1.0, and clamp into
   * `[0.3, 1.0]`.
   */
  public fun fitScale(
    frameWidthPx: Float,
    frameHeightPx: Float,
    viewportWidth: Float,
    viewportHeight: Float,
    padding: Float = DEFAULT_PADDING,
  ): Float =
    minOf(
        viewportWidth / (frameWidthPx + padding * 2),
        viewportHeight / (frameHeightPx + padding * 2),
        1f,
      )
      .coerceIn(0.3f, 1f)

  /**
   * Convert a viewport point to a device coordinate. Removes pan ([DeviceScreenGeometry.offsetX] /
   * `offsetY`) and zoom ([DeviceScreenGeometry.scale]), then scales frame pixels to device
   * coordinates using the width-based ratio (see class contract). Never clamps; see
   * [DevicePoint.inBounds].
   */
  public fun viewportToDevice(point: ViewportPoint, geometry: DeviceScreenGeometry): DevicePoint {
    val frameX = (point.x - geometry.offsetX) / geometry.scale
    val frameY = (point.y - geometry.offsetY) / geometry.scale
    val frameToDevice =
      if (geometry.frameWidthPx > 0f) geometry.deviceWidth.toFloat() / geometry.frameWidthPx else 1f
    val deviceX = (frameX * frameToDevice).roundToInt()
    val deviceY = (frameY * frameToDevice).roundToInt()
    val inBounds =
      deviceX in 0 until geometry.deviceWidth && deviceY in 0 until geometry.deviceHeight
    return DevicePoint(deviceX, deviceY, inBounds)
  }

  /**
   * Inverse of [viewportToDevice]: map a device coordinate back to a viewport point (e.g. to place
   * an overlay or touch-feedback marker). Modulo integer rounding, `deviceToViewport` and
   * `viewportToDevice` round-trip.
   */
  public fun deviceToViewport(
    deviceX: Int,
    deviceY: Int,
    geometry: DeviceScreenGeometry,
  ): ViewportPoint {
    val deviceToFrame =
      if (geometry.deviceWidth > 0) geometry.frameWidthPx / geometry.deviceWidth.toFloat() else 1f
    val frameX = deviceX * deviceToFrame
    val frameY = deviceY * deviceToFrame
    return ViewportPoint(
      x = frameX * geometry.scale + geometry.offsetX,
      y = frameY * geometry.scale + geometry.offsetY,
    )
  }
}
