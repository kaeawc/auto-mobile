package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import android.app.Application
import androidx.compose.runtime.Composable
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeInsetFloor
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypePlacement
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRequest
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeSpecContent
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeWindowContent
import dev.jasonpearson.automobile.ctrlproxy.prototype.mapPrototypeSpec
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Host chrome snapshots (#11217): the fullscreen dismiss bar and the persistent Close control of
 * `PrototypeWindowContent`, each in light and dark. The request's `darkTheme` is what the host
 * derives from the spec, so the device night mode stays at its default.
 *
 * Every baseline is pending until recorded on Linux with the `Record Desktop Screenshot Baselines`
 * workflow; [PrototypeRenderThemeTest] checks the light/dark difference on any OS meanwhile.
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
  fun dismissBarDark() = chromeTest("host_chrome_dismiss_bar_dark", dark = true, fullscreen = true)

  /** Floating and persistent: the Close control over the spec, light. */
  @Test
  fun closeControlLight() =
    chromeTest("host_chrome_close_control_light", dark = false, fullscreen = false)

  /** Floating and persistent: the Close control over the spec, dark. */
  @Test
  fun closeControlDark() =
    chromeTest("host_chrome_close_control_dark", dark = true, fullscreen = false)

  private fun chromeTest(name: String, dark: Boolean, fullscreen: Boolean) {
    PrototypeScreenshotEnvironment.assumeReferencePlatform()
    PrototypeScreenshotEnvironment.skipIfPending(name, pending = true)
    PrototypeScreenshotEnvironment.handleResult(
      BitmapPngCodec,
      name,
      renderPrototypeChrome(name, dark, fullscreen),
      PrototypeScreenshotComparator.Options(),
    )
  }
}

/** Renders `PrototypeWindowContent` around the `doc-example-3` styled box. */
internal fun renderPrototypeChrome(
  name: String,
  dark: Boolean,
  fullscreen: Boolean,
): PrototypeScreenshotComparator.Image {
  val model = mapPrototypeSpec(validPrototypeFixture("doc-example-3", resolveElementAnchors = true))
  val request =
    PrototypeRequest(
      placement =
        if (fullscreen) PrototypePlacement.Fullscreen() else PrototypePlacement.Floating(),
      persistent = !fullscreen,
      darkTheme = dark,
      content = { PrototypeSpecContent(model.root, theme = model.theme) },
    )
  val content: @Composable () -> Unit = {
    PrototypeWindowContent(request) { PrototypeInsetFloor.None }
  }
  return renderComposable(name, content)
}
