package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.domain.DeviceScreenCoordinateMapper
import dev.jasonpearson.automobile.desktop.domain.DeviceScreenGeometry
import dev.jasonpearson.automobile.desktop.domain.TouchFeedbackMarker
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * Pulse placement must be the canonical mapper's inverse transform, not a private re-derivation
 * (issue #4546): `touchFeedbackCenter` builds a [DeviceScreenGeometry] from the marker's own
 * captured snapshot bounds and delegates to [DeviceScreenCoordinateMapper.deviceToViewport]. These
 * tests pin both the delegation (any drift from the mapper's output fails) and the concrete values
 * the old width-based transform produced, so the API move is behavior-preserving.
 */
class TouchFeedbackPlacementTest {

  private fun marker(x: Int, y: Int, w: Int, h: Int) =
    TouchFeedbackMarker(x = x, y = y, deviceWidth = w, deviceHeight = h, startedAtMs = 0L)

  @Test
  fun `placement scales through the marker's captured device width, not a live one`() {
    // A center tap captured against a 1080-wide snapshot, rendered into a 540px-wide frame:
    // exactly half device -> the frame center x. Same values the pre-#4546 transform produced.
    val center = touchFeedbackCenter(marker(540, 1170, 1080, 2340), 540f, 1170f)
    assertNotNull(center)
    assertEquals(270f, center.x)
    assertEquals(585f, center.y)

    // The SAME device point captured against a different (e.g. post-resolution-change) snapshot
    // width lands at a DIFFERENT frame offset for the same frame — proving the captured width,
    // not a live dimension, drives placement.
    val stale = touchFeedbackCenter(marker(540, 1170, 720, 1560), 540f, 1170f)
    assertNotNull(stale)
    assertEquals(405f, stale.x)
  }

  @Test
  fun `placement equals the canonical mapper's deviceToViewport for the marker geometry`() {
    // Delegation pin: for a spread of markers and frame sizes, the placement is byte-identical to
    // calling the canonical mapper with the frame-local geometry (scale 1, no pan, captured
    // bounds). A placement path that re-derives its own transform diverges here as soon as the
    // mapper changes — which is the drift #4546 exists to prevent.
    val cases =
      listOf(
        Triple(marker(0, 0, 1080, 2340), 540f, 1170f),
        Triple(marker(1079, 2339, 1080, 2340), 540f, 1170f),
        Triple(marker(333, 777, 720, 1560), 411f, 890.5f),
        Triple(marker(100, 200, 2340, 1080), 900f, 415.4f),
      )
    for ((m, frameW, frameH) in cases) {
      val expected =
        DeviceScreenCoordinateMapper.deviceToViewport(
          m.x,
          m.y,
          DeviceScreenGeometry(
            frameWidthPx = frameW,
            frameHeightPx = frameH,
            scale = 1f,
            offsetX = 0f,
            offsetY = 0f,
            deviceWidth = m.deviceWidth,
            deviceHeight = m.deviceHeight,
          ),
        )
      assertEquals(expected, touchFeedbackCenter(m, frameW, frameH))
    }
  }

  @Test
  fun `a degenerate zero-width snapshot places no pulse`() {
    // No addressable pixel to place a pulse at -> nothing is drawn (the draw loop skips it).
    assertNull(touchFeedbackCenter(marker(5, 9, 0, 0), 540f, 1170f))
  }
}
