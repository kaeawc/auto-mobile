package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import android.app.Application
import androidx.compose.runtime.Composable
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeEscapeState
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeInsetFloor
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypePlacement
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRequest
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeSpecContent
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeWindowChrome
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeWindowContent
import dev.jasonpearson.automobile.ctrlproxy.prototype.mapPrototypeSpec
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeShownThemeFlow
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Host chrome snapshots (#11217): the fullscreen dismiss bar and the persistent Close control of
 * `PrototypeWindowContent`, each in light and dark. The request's `theme` is what the controller
 * resolves for the show, so the device night mode stays at its default.
 *
 * Every baseline is pending until recorded on Linux with the `Record Desktop Screenshot Baselines`
 * workflow (module `control-proxy`, test filter `*Prototype*ScreenshotTest`, covering this class
 * and `PrototypeSpecContentScreenshotTest`); [PrototypeRenderThemeTest] checks the light/dark
 * difference on any OS meanwhile.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h640dp-mdpi", application = Application::class)
class PrototypeHostChromeScreenshotTest {

  /** Fullscreen: the translucent dismiss bar above the spec, light. */
  @Test
  fun dismissBarLight() =
    chromeTest("host_chrome_dismiss_bar_light", dark = false, fullscreen = true)

  /** Fullscreen: the translucent dismiss bar above the spec, dark. */
  @Test
  fun dismissBarDark() =
    chromeTest("host_chrome_dismiss_bar_dark", dark = true, fullscreen = true)

  /** Floating and persistent: the Close control over the spec, light. */
  @Test
  fun closeControlLight() =
    chromeTest("host_chrome_close_control_light", dark = false, fullscreen = false)

  /** Floating and persistent: the Close control over the spec, dark. */
  @Test
  fun closeControlDark() =
    chromeTest("host_chrome_close_control_dark", dark = true, fullscreen = false)

  @Test
  fun chromelessLight() = chromelessTest("host_chrome_none_light", dark = false, revealed = false)

  @Test
  fun chromelessDark() = chromelessTest("host_chrome_none_dark", dark = true, revealed = false)

  @Test
  fun escapePillLight() =
    chromelessTest("host_chrome_escape_pill_light", dark = false, revealed = true)

  @Test
  fun escapePillDark() =
    chromelessTest("host_chrome_escape_pill_dark", dark = true, revealed = true)

  /** Chromeless baselines are pending until recorded on Linux, like the ones above. */
  private fun chromelessTest(name: String, dark: Boolean, revealed: Boolean) =
    prototypeScreenshotTest(name) {
      renderPrototypeChrome(
        name,
        dark,
        fullscreen = true,
        chrome = PrototypeWindowChrome.NONE,
        revealed = revealed,
      )
    }

  private fun chromeTest(
    name: String,
    dark: Boolean,
    fullscreen: Boolean,
    pending: Boolean = false,
  ) = prototypeScreenshotTest(name, pending) { renderPrototypeChrome(name, dark, fullscreen) }
}

/** Renders `PrototypeWindowContent` around the `doc-example-3` styled box. */
internal fun renderPrototypeChrome(
  name: String,
  dark: Boolean,
  fullscreen: Boolean,
  chrome: PrototypeWindowChrome = PrototypeWindowChrome.BAR,
  revealed: Boolean = false,
): PrototypeScreenshotComparator.Image {
  val model = mapPrototypeSpec(validPrototypeFixture("doc-example-3", resolveElementAnchors = true))
  val request =
    PrototypeRequest(
      placement =
        if (fullscreen) PrototypePlacement.Fullscreen() else PrototypePlacement.Floating(),
      persistent = !fullscreen,
      chrome = chrome,
      theme = prototypeShownThemeFlow(model, dark),
      content = { PrototypeSpecContent(model.root, theme = model.theme) },
    )
  val escape = PrototypeEscapeState().apply { if (revealed) reveal() }
  val content: @Composable () -> Unit = {
    PrototypeWindowContent(request, escape) { PrototypeInsetFloor.None }
  }
  return renderComposable(name, content)
}
