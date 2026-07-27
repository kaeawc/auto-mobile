package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.domain.DeviceScreenCoordinateMapper
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenGeometry
import dev.jasonpearson.automobile.desktop.domain.ViewportPoint
import kotlin.test.assertEquals
import org.junit.Test

/**
 * Cross-language golden vectors for viewport <-> device coordinate mapping (issue #4547, B0 of the
 * canonical-pixel campaign #4547 -> #4548 -> #4549 -> #4550).
 *
 * The canonical single source is `test/fixtures/coordinate-mapping-golden-vectors.json` at the repo
 * root. The inline tables below are a committed copy of its five [DeviceScreenCoordinateMapper]
 * sections; `test/parity/coordinateMappingGoldenVectorParity.test.ts` parses these literals out of
 * this file's source and verifies them against the JSON (the same drift-guard mechanism as
 * `PinchGeometryTest.kt` / `pinch-golden-vectors.json`), so a one-sided edit of either side fails
 * `bun test`.
 *
 * KEEP THE TABLES PURELY NUMERIC: no string literals and no booleans inside the `listOf(...)`
 * regions (booleans are encoded as 0/1) — the TypeScript parser extracts numbers positionally. Row
 * order must match the JSON.
 *
 * These vectors PIN CURRENT BEHAVIOR. The iOS point-space rows (flagged
 * willChangeUnderCanonicalPixels in the JSON) MUST change when #4549 converts hierarchy bounds to
 * canonical pixels; update the JSON and every consumer together in that PR.
 */
class CoordinateMappingGoldenVectorTest {

  private val mapper = DeviceScreenCoordinateMapper

  private data class ViewportToDeviceVector(
    val frameWidthPx: Float,
    val frameHeightPx: Float,
    val scale: Float,
    val offsetX: Float,
    val offsetY: Float,
    val deviceWidth: Int,
    val deviceHeight: Int,
    val viewportX: Float,
    val viewportY: Float,
    val expectedX: Int,
    val expectedY: Int,
    val expectedInBounds: Int,
  )

  private val viewportToDeviceVectors =
    listOf(
      // Android 1080x2340 portrait, frame at half device size: frame center -> device center.
      ViewportToDeviceVector(540f, 1170f, 1f, 0f, 0f, 1080, 2340, 270f, 585f, 540, 1170, 1),
      // Zoom removal: at scale 2 a viewport point twice as far maps to the same device point.
      ViewportToDeviceVector(540f, 1170f, 2f, 0f, 0f, 1080, 2340, 540f, 1170f, 540, 1170, 1),
      // Pan removal: device origin sits at the pan offset.
      ViewportToDeviceVector(540f, 1170f, 1f, 100f, 50f, 1080, 2340, 100f, 50f, 0, 0, 1),
      // Pan + zoom combined.
      ViewportToDeviceVector(540f, 1170f, 2f, 100f, 50f, 1080, 2340, 370f, 635f, 270, 585, 1),
      // Rounding boundary: device 0.5 rounds half-up to 1.
      ViewportToDeviceVector(540f, 1170f, 1f, 0f, 0f, 1080, 2340, 0.25f, 0f, 1, 0, 1),
      // Negative rounding boundary: device -0.5 rounds toward positive infinity to 0.
      ViewportToDeviceVector(540f, 1170f, 1f, 0f, 0f, 1080, 2340, -0.25f, 0f, 0, 0, 1),
      // Out of bounds at exactly deviceWidth: bounds are exclusive, no clamping.
      ViewportToDeviceVector(540f, 1170f, 1f, 0f, 0f, 1080, 2340, 540f, 585f, 1080, 1170, 0),
      // Negative out of bounds: raw coordinates returned, never clamped.
      ViewportToDeviceVector(540f, 1170f, 1f, 0f, 0f, 1080, 2340, -10f, -10f, -20, -20, 0),
      // Far past the bottom-right edge.
      ViewportToDeviceVector(540f, 1170f, 1f, 0f, 0f, 1080, 2340, 1000f, 2000f, 2000, 4000, 0),
      // Landscape device space (rotation-aligned upstream).
      ViewportToDeviceVector(1170f, 540f, 1f, 0f, 0f, 2340, 1080, 585f, 270f, 1170, 540, 1),
      // Degenerate zero frame width: frame-to-device ratio falls back to 1.
      ViewportToDeviceVector(0f, 0f, 1f, 0f, 0f, 1080, 2340, 12.5f, 7f, 13, 7, 1),
      // iOS 3x device (390x844): device space is POINTS today; changes under #4549.
      ViewportToDeviceVector(390f, 844f, 1f, 0f, 0f, 390, 844, 195f, 422f, 195, 422, 1),
      // iOS 2x device (375x667) with fractional viewport input; changes under #4549.
      ViewportToDeviceVector(375f, 667f, 1f, 0f, 0f, 375, 667, 100.4f, 200.6f, 100, 201, 1),
      // iOS Display Zoom-like device (320x693 zoomed points at 3x); changes under #4549.
      ViewportToDeviceVector(320f, 693f, 1f, 0f, 0f, 320, 693, 160f, 346.5f, 160, 347, 1),
      // Width-derived-ratio invariant: aspect-MISMATCHED frame (width ratio 2, height ratio
      // 4). Pins that BOTH axes scale by deviceWidth/frameWidthPx (height-derived y = 800).
      ViewportToDeviceVector(500f, 500f, 1f, 0f, 0f, 1000, 2000, 100f, 200f, 200, 400, 1),
    )

  private data class DeviceToViewportVector(
    val deviceX: Int,
    val deviceY: Int,
    val frameWidthPx: Float,
    val frameHeightPx: Float,
    val scale: Float,
    val offsetX: Float,
    val offsetY: Float,
    val deviceWidth: Int,
    val deviceHeight: Int,
    val expectedX: Float,
    val expectedY: Float,
  )

  private val deviceToViewportVectors =
    listOf(
      // Inverse of the identity half-frame case: device center back to frame center.
      DeviceToViewportVector(540, 1170, 540f, 1170f, 1f, 0f, 0f, 1080, 2340, 270f, 585f),
      // Inverse with pan + zoom.
      DeviceToViewportVector(270, 585, 540f, 1170f, 2f, 100f, 50f, 1080, 2340, 370f, 635f),
      // Degenerate zero device width: device-to-frame ratio falls back to 1.
      DeviceToViewportVector(7, 9, 540f, 1170f, 1f, 10f, 20f, 0, 2340, 17f, 29f),
      // iOS 3x point-space inverse; changes under #4549.
      DeviceToViewportVector(195, 422, 390f, 844f, 1f, 0f, 0f, 390, 844, 195f, 422f),
    )

  private data class FitToViewportVector(
    val imageWidth: Int,
    val imageHeight: Int,
    val viewportWidth: Float,
    val viewportHeight: Float,
    val padding: Float,
    val expectedWidthPx: Float,
    val expectedHeightPx: Float,
  )

  private val fitToViewportVectors =
    listOf(
      // Height-constrained: 1080x2160 (aspect 2.0) in 800x800 with 32 padding.
      FitToViewportVector(1080, 2160, 800f, 800f, 32f, 368f, 736f),
      // Width-constrained: narrow tall viewport.
      FitToViewportVector(1080, 2160, 400f, 2000f, 32f, 336f, 672f),
      // Landscape image (aspect 0.5): width-constrained.
      FitToViewportVector(2160, 1080, 1200f, 1200f, 32f, 1136f, 568f),
      // Unknown image width falls back to aspect ratio 2.16.
      FitToViewportVector(0, 0, 800f, 800f, 32f, 340.7407f, 736f),
      // Tiny viewport: max frame sides coerce to the 1px floor.
      FitToViewportVector(1080, 2160, 10f, 10f, 32f, 0.5f, 1f),
    )

  private data class FitScaleVector(
    val frameWidthPx: Float,
    val frameHeightPx: Float,
    val viewportWidth: Float,
    val viewportHeight: Float,
    val padding: Float,
    val expected: Float,
  )

  private val fitScaleVectors =
    listOf(
      // Frame fits comfortably: scale caps at 1.0.
      FitScaleVector(300f, 600f, 800f, 1200f, 32f, 1f),
      // Frame far larger than viewport: clamps to the 0.3 floor.
      FitScaleVector(5000f, 5000f, 400f, 400f, 32f, 0.3f),
      // Mid-range: 736+64=800 padded frame in a 400-wide viewport.
      FitScaleVector(736f, 736f, 400f, 800f, 32f, 0.5f),
    )

  private data class ScreenshotRotationVector(
    val imageWidth: Int,
    val imageHeight: Int,
    val rootWidth: Int,
    val rootHeight: Int,
    val expected: Int,
  )

  private val screenshotRotationVectors =
    listOf(
      // Portrait image, portrait bounds: no rotation.
      ScreenshotRotationVector(1080, 2340, 1080, 2340, 0),
      // Landscape image, landscape bounds: no rotation.
      ScreenshotRotationVector(2340, 1080, 2340, 1080, 0),
      // Portrait image, landscape bounds: rotate 90 CW.
      ScreenshotRotationVector(1080, 2340, 2340, 1080, 3),
      // Landscape image, portrait bounds: rotate 270 CW.
      ScreenshotRotationVector(2340, 1080, 1080, 2340, 1),
      // Non-positive image width: no rotation inferred.
      ScreenshotRotationVector(0, 2340, 1080, 2340, 0),
      // Non-positive root dimensions: no rotation inferred.
      ScreenshotRotationVector(1080, 2340, 0, 0, 0),
      // iOS pixel screenshot vs point-space root: orientations agree across units.
      ScreenshotRotationVector(1170, 2532, 390, 844, 0),
      // Square image counts as landscape against portrait bounds.
      ScreenshotRotationVector(1000, 1000, 1080, 2340, 1),
    )

  private fun geometry(vector: ViewportToDeviceVector) =
    DeviceScreenGeometry(
      frameWidthPx = vector.frameWidthPx,
      frameHeightPx = vector.frameHeightPx,
      scale = vector.scale,
      offsetX = vector.offsetX,
      offsetY = vector.offsetY,
      deviceWidth = vector.deviceWidth,
      deviceHeight = vector.deviceHeight,
    )

  private fun geometry(vector: DeviceToViewportVector) =
    DeviceScreenGeometry(
      frameWidthPx = vector.frameWidthPx,
      frameHeightPx = vector.frameHeightPx,
      scale = vector.scale,
      offsetX = vector.offsetX,
      offsetY = vector.offsetY,
      deviceWidth = vector.deviceWidth,
      deviceHeight = vector.deviceHeight,
    )

  @Test
  fun `viewportToDevice matches the golden vectors`() {
    for ((index, vector) in viewportToDeviceVectors.withIndex()) {
      val point =
        mapper.viewportToDevice(ViewportPoint(vector.viewportX, vector.viewportY), geometry(vector))
      assertEquals(vector.expectedX, point.x, "row $index x")
      assertEquals(vector.expectedY, point.y, "row $index y")
      assertEquals(vector.expectedInBounds == 1, point.inBounds, "row $index inBounds")
    }
  }

  @Test
  fun `deviceToViewport matches the golden vectors`() {
    for ((index, vector) in deviceToViewportVectors.withIndex()) {
      val point = mapper.deviceToViewport(vector.deviceX, vector.deviceY, geometry(vector))
      assertEquals(vector.expectedX, point.x, TOLERANCE, "row $index x")
      assertEquals(vector.expectedY, point.y, TOLERANCE, "row $index y")
    }
  }

  @Test
  fun `fitToViewport matches the golden vectors`() {
    for ((index, vector) in fitToViewportVectors.withIndex()) {
      val frame =
        mapper.fitToViewport(
          vector.imageWidth,
          vector.imageHeight,
          vector.viewportWidth,
          vector.viewportHeight,
          vector.padding,
        )
      assertEquals(vector.expectedWidthPx, frame.widthPx, TOLERANCE, "row $index width")
      assertEquals(vector.expectedHeightPx, frame.heightPx, TOLERANCE, "row $index height")
    }
  }

  @Test
  fun `fitScale matches the golden vectors`() {
    for ((index, vector) in fitScaleVectors.withIndex()) {
      val scale =
        mapper.fitScale(
          vector.frameWidthPx,
          vector.frameHeightPx,
          vector.viewportWidth,
          vector.viewportHeight,
          vector.padding,
        )
      assertEquals(vector.expected, scale, TOLERANCE, "row $index")
    }
  }

  @Test
  fun `detectScreenshotRotation matches the golden vectors`() {
    for ((index, vector) in screenshotRotationVectors.withIndex()) {
      val rotation =
        mapper.detectScreenshotRotation(
          vector.imageWidth,
          vector.imageHeight,
          vector.rootWidth,
          vector.rootHeight,
        )
      assertEquals(vector.expected, rotation, "row $index")
    }
  }

  private companion object {
    const val TOLERANCE = 0.001f
  }
}
