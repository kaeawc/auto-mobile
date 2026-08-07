package dev.jasonpearson.automobile.design.system.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pins the chunkier hand-drawn shape scale (AC3). */
class PlaygroundShapesTest {

  @Test
  fun shapeScale_isChunkyHandDrawn() {
    assertEquals(RoundedCornerShape(6.dp), AutoMobileShapes.extraSmall)
    assertEquals(RoundedCornerShape(12.dp), AutoMobileShapes.small)
    assertEquals(RoundedCornerShape(18.dp), AutoMobileShapes.medium)
    assertEquals(RoundedCornerShape(26.dp), AutoMobileShapes.large)
    assertEquals(RoundedCornerShape(40.dp), AutoMobileShapes.extraLarge)
  }

  @Test
  fun customShapes_stillProvided() {
    assertEquals(RoundedCornerShape(14.dp), AutoMobileCustomShapes.button)
    assertEquals(RoundedCornerShape(18.dp), AutoMobileCustomShapes.card)
    assertEquals(RoundedCornerShape(12.dp), AutoMobileCustomShapes.textField)
  }
}

/**
 * Pins that the Shantell Sans font and its SIL Open Font License are vendored into the repo (AC2),
 * so a build/checkout can never render the branded type from a missing asset. Searches upward from
 * the test working directory to stay robust to how Gradle sets it.
 */
class PlaygroundFontAssetTest {

  private fun findRepoFile(relative: String): File? {
    var dir: File? = File(System.getProperty("user.dir")).absoluteFile
    repeat(8) {
      val candidate = File(dir, relative)
      if (candidate.exists()) return candidate
      dir = dir?.parentFile
    }
    return null
  }

  @Test
  fun shantellSansFont_isVendored() {
    val font = findRepoFile("android/playground/design/assets/src/main/res/font/shantell_sans.ttf")
    assertTrue(
      "Shantell Sans font must be committed under design/assets res/font",
      font != null && font.length() > 0,
    )
  }

  @Test
  fun openFontLicense_isCommittedWithTheFont() {
    // res/font/ only accepts font files, so the SIL OFL lives in the module's
    // licenses/ directory.
    val license = findRepoFile("android/playground/design/assets/licenses/ShantellSans-OFL.txt")
    assertTrue(
      "Shantell Sans OFL licence must be committed",
      license != null && license.length() > 0,
    )
  }
}
