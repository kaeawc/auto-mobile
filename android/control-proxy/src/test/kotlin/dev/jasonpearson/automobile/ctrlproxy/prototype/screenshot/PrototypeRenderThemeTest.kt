package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import android.app.Application
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * [renderPrototype] must pass the spec's own theme to the renderer (#11217): a `mode: dark` spec
 * draws light-on-dark ink on a light device. Compares luminance, not baselines, so it runs on any
 * OS.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = Application::class, qualifiers = "+notnight")
class PrototypeRenderThemeTest {

  @Test
  fun darkSpecThemeDrawsLightInkOnLightDevice() {
    val image = renderPrototype("theme-seed", validPrototypeFixture("theme-seed"))
    assertTrue("expected light ink, got ${luminance(image)}", luminance(image) > 0.7)
  }

  @Test
  fun lightSpecThemeDrawsDarkInkOnLightDevice() {
    val image =
      renderPrototype("theme-typography-shapes", validPrototypeFixture("theme-typography-shapes"))
    assertTrue("expected dark ink, got ${luminance(image)}", luminance(image) < 0.3)
  }

  /** Mean luminance of the opaque-ish pixels: the surface when painted, else the text ink. */
  private fun luminance(image: PrototypeScreenshotComparator.Image): Double {
    val drawn = image.pixels.filter { (it ushr 24) > 0x80 }
    check(drawn.isNotEmpty()) { "prototype drew nothing opaque" }
    return drawn.map(::pixelLuminance).average()
  }

  private fun pixelLuminance(argb: Int): Double {
    val r = (argb shr 16) and 0xFF
    val g = (argb shr 8) and 0xFF
    val b = argb and 0xFF
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
  }
}
