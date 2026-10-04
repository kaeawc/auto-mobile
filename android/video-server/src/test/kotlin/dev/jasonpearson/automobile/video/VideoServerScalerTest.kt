package dev.jasonpearson.automobile.video

import dev.jasonpearson.automobile.video.wrappers.DisplayControl
import org.junit.Assert.assertEquals
import org.junit.Test

class VideoServerScalerTest {

  @Test
  fun presetCapsAndEvenRoundingMatchHost() {
    for (quality in listOf(QualityPreset.LOW, QualityPreset.MEDIUM, QualityPreset.HIGH)) {
      val cap = quality.maxHeight
      val cases =
        listOf(
          Triple(1200, 2400, (cap / 2) to cap),
          Triple(2400, 1200, cap to (cap / 2)),
          Triple(2400, 2400, cap to cap),
          Triple(cap - 1, 301, (cap - 2) to 300),
          Triple(301, cap - 1, 300 to (cap - 2)),
        )
      for ((width, height, expected) in cases) {
        assertDimensions(width, height, quality, expected)
      }
    }
  }

  @Test
  fun extremeAspectRatiosAndTinySizesKeepAtLeastTwoPixelsPerEdge() {
    assertDimensions(3, 2000, QualityPreset.HIGH, 2 to 1080)
    assertDimensions(2000, 3, QualityPreset.HIGH, 1080 to 2)
    assertDimensions(1, 1, QualityPreset.LOW, 2 to 2)
    assertDimensions(2, 4, QualityPreset.LOW, 2 to 4)
  }

  @Test
  fun ordinaryPhoneDimensionsRetainExistingScaling() {
    val cases =
      listOf(
        Triple(QualityPreset.LOW, 242 to 540, 248 to 540),
        Triple(QualityPreset.MEDIUM, 324 to 720, 332 to 720),
        Triple(QualityPreset.HIGH, 486 to 1080, 498 to 1080),
      )
    for ((quality, phone1080, phone1440) in cases) {
      assertDimensions(1080, 2400, quality, phone1080)
      assertDimensions(2400, 1080, quality, phone1080.second to phone1080.first)
      assertDimensions(1440, 3120, quality, phone1440)
      assertDimensions(3120, 1440, quality, phone1440.second to phone1440.first)
    }
  }

  private fun assertDimensions(
    width: Int,
    height: Int,
    quality: QualityPreset,
    expected: Pair<Int, Int>,
  ) {
    val display =
      DisplayControl.DisplayInfo(width = width, height = height, densityDpi = 420, rotation = 0)
    assertEquals(
      "${width}x${height} at $quality",
      expected,
      VideoServer.calculateOutputDimensions(display, quality),
    )
  }
}
