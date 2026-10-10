package dev.jasonpearson.automobile.ctrlproxy.overlay.screenshot

import android.app.Application
import org.junit.Assume
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Host-side overlay preview (issue #10445): renders the spec files named by `-Doverlay.preview.*`
 * through the production renderer, with no device attached, and writes PNGs. Skipped unless a spec
 * is requested, so it is a no-op in the normal unit-test run. Run it through
 * `scripts/overlay/preview.sh`; see [OverlayPreviewRequest] for the switches.
 *
 * Unlike the snapshot tests it runs on any OS: nothing is compared, so cross-OS font rasterization
 * differences do not matter.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = Application::class)
class OverlayPreviewRenderTest {

  @Test
  fun renderPreview() {
    val request = OverlayPreviewRequest.fromProperties(System::getProperty)
    Assume.assumeTrue(
      "No -D${OverlayPreviewRequest.SPEC_PROPERTY}; nothing to preview",
      request != null,
    )
    request!!
    RuntimeEnvironment.setQualifiers(request.qualifiers)
    val images =
      request.specs.map { spec ->
        val image = renderOverlay(spec.name, loadOverlaySpec(spec))
        BitmapPngCodec.write(request.outputFor(spec), image)
        image
      }
    if (images.size > 1) {
      BitmapPngCodec.write(request.contactSheet, overlayContactSheet(images))
    }
  }
}
