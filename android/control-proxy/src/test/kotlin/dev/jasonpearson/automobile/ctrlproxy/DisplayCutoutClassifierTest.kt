package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.DisplayCutoutBoundsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.DisplayCutoutClassifier
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.models.SystemInsetsInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class DisplayCutoutClassifierTest {
  @Test
  fun `classifies an empty cutout with zero insets as none`() {
    assertEquals(
      "none",
      DisplayCutoutClassifier.classify(
        bounds = emptyList(),
        screen = ScreenDimensions(width = 1080, height = 2400),
        cutoutInsets = SystemInsetsInfo(),
      ),
    )
  }

  @Test
  fun `classifies a wide top cutout as a notch`() {
    assertEquals(
      "notch",
      DisplayCutoutClassifier.classify(
        bounds = listOf(DisplayCutoutBoundsInfo(left = 380, top = 0, right = 700, bottom = 80)),
        screen = ScreenDimensions(width = 1080, height = 2400),
        cutoutInsets = SystemInsetsInfo(top = 80),
      ),
    )
  }

  @Test
  fun `classifies a compact edge cutout as a hole punch`() {
    assertEquals(
      "hole_punch",
      DisplayCutoutClassifier.classify(
        bounds = listOf(DisplayCutoutBoundsInfo(left = 510, top = 0, right = 570, bottom = 60)),
        screen = ScreenDimensions(width = 1080, height = 2400),
        cutoutInsets = SystemInsetsInfo(top = 60),
      ),
    )
  }

  @Test
  fun `classifies rotated notch geometry in current screen coordinates`() {
    assertEquals(
      "notch",
      DisplayCutoutClassifier.classify(
        bounds = listOf(DisplayCutoutBoundsInfo(left = 0, top = 380, right = 80, bottom = 700)),
        screen = ScreenDimensions(width = 2400, height = 1080),
        cutoutInsets = SystemInsetsInfo(left = 80),
      ),
    )
  }

  @Test
  fun `keeps unsupported Dynamic Island-like and unavailable metadata unknown`() {
    val screen = ScreenDimensions(width = 1170, height = 2532)

    assertEquals(
      "unknown",
      DisplayCutoutClassifier.classify(
        bounds = listOf(DisplayCutoutBoundsInfo(left = 410, top = 40, right = 760, bottom = 130)),
        screen = screen,
        cutoutInsets = SystemInsetsInfo(top = 130),
      ),
    )
    assertEquals(
      "unknown",
      DisplayCutoutClassifier.classify(
        bounds = emptyList(),
        screen = screen,
        cutoutInsets = SystemInsetsInfo(top = 80),
      ),
    )
  }
}
