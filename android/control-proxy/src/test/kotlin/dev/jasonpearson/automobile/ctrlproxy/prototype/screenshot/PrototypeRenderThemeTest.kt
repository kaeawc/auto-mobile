package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import android.app.Application
import kotlinx.serialization.json.JsonPrimitive
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

  /** The dark gallery cases open a sheet and a dialog through state overrides; they must show. */
  @Test
  fun stateOverridesOpenTheSheetAndDialog() {
    val open = JsonPrimitive(true)
    listOf(
        Triple("fullscreen-all-nodes", "open", open),
        Triple("material-app-bar-dialog-pickers", "editing", open),
      )
      .forEach { (fixture, key, value) ->
        val closed = renderPrototype(fixture, validPrototypeFixture(fixture))
        val opened =
          renderPrototype(
            fixture,
            validPrototypeFixture(fixture, stateOverrides = mapOf(key to value)),
          )
        assertTrue(
          "$fixture: $key=true changed nothing",
          !closed.pixels.contentEquals(opened.pixels),
        )
      }
  }

  @Test
  fun hostChromeFollowsDarkThemeRequest() {
    listOf(true, false).forEach { fullscreen ->
      val light = renderPrototypeChrome("chrome-light", dark = false, fullscreen = fullscreen)
      val dark = renderPrototypeChrome("chrome-dark", dark = true, fullscreen = fullscreen)
      assertTrue(
        "fullscreen=$fullscreen: dark chrome ${luminance(dark)} not darker than ${luminance(light)}",
        luminance(dark) < luminance(light),
      )
    }
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
