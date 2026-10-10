package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import android.app.Application
import org.junit.Assume
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Host-side prototype preview (issue #10445): renders the spec files named by
 * `-Dprototype.preview.*` through the production renderer, with no device attached, and writes
 * PNGs. Skipped unless a spec is requested, so it is a no-op in the normal unit-test run. Run it
 * through `scripts/prototype/preview.sh`; see [PrototypePreviewRequest] for the switches.
 *
 * Unlike the snapshot tests it runs on any OS: nothing is compared, so cross-OS font rasterization
 * differences do not matter.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], application = Application::class)
class PrototypePreviewRenderTest {

  @Test
  fun renderPreview() {
    val request = PrototypePreviewRequest.fromProperties(System::getProperty)
    Assume.assumeTrue(
      "No -D${PrototypePreviewRequest.SPEC_PROPERTY}; nothing to preview",
      request != null,
    )
    request!!
    RuntimeEnvironment.setQualifiers(request.qualifiers)
    val images =
      request.specs.map { spec ->
        val image = renderPrototype(spec.name, loadPrototypeSpec(spec))
        BitmapPngCodec.write(request.outputFor(spec), image)
        image
      }
    if (images.size > 1) {
      BitmapPngCodec.write(request.contactSheet, prototypeContactSheet(images))
    }
  }
}
