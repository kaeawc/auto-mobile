package dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot

import android.app.Application
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRuntime
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import dev.jasonpearson.automobile.prototype.EmbeddedPrototypeHost
import dev.jasonpearson.automobile.prototype.ProvideEmbeddedPrototypeHost
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A fixed sample of existing, non-pending content goldens. Activity/overlay chrome is deliberately
 * absent, matching their original renderPrototype content path. Never records or replaces goldens,
 * even when the surrounding screenshot suite is in record mode. One capture per test bounds cost.
 */
@RunWith(RobolectricTestRunner::class)
@OptIn(ExperimentalCoroutinesApi::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w360dp-h640dp-mdpi", application = Application::class)
class AutoMobilePrototypeParityScreenshotTest {
  // Own Compose's frame clock and effect scheduler, as in SavedPrototypeActivityTest;
  // the embedded API renders only after an effect.
  @get:Rule val compose = createComposeRule()

  @Test fun materialControls() = parity("material_controls", "material-controls")

  @Test fun selectionControls() = parity("selection_controls", "selection-controls")

  @Test fun repeatedContent() = parity("repeat", "repeat")

  @Test fun rowWeightSizeBounds() = parity("row_weight_size_bounds", "row-weight-size-bounds")

  private fun parity(golden: String, fixture: String) {
    PrototypeScreenshotEnvironment.assumeReferencePlatform()
    val spec = Json.encodeToString(validPrototypeFixture(fixture))
    val dispatcher = UnconfinedTestDispatcher()
    val scope = CoroutineScope(SupervisorJob() + dispatcher)
    var runtime: PrototypeRuntime? = null
    val host =
      EmbeddedPrototypeHost(scope, Mutex(), dispatcher).apply {
        clock = { 42L }
        onRuntime = { runtime = it }
      }
    try {
      val actual =
        renderComposable("embedded_$golden", settle = { compose.waitForIdle() }) {
          ProvideEmbeddedPrototypeHost(host) {
            AutoMobilePrototype(spec, onError = { error("$fixture: $it") })
          }
        }
      val baseline =
        File(
          System.getProperty("screenshot.golden.dir") ?: "src/test/resources/screenshots/prototype",
          "$golden.png",
        )
      val reportDir =
        File(
          System.getProperty("screenshot.report.dir") ?: "build/reports/screenshots/prototype",
        )
      val result =
        PrototypeScreenshotComparator.compare(
          BitmapPngCodec,
          baseline,
          actual,
          reportDir,
          "embedded_$golden",
        )
      assertEquals("$fixture: $result", PrototypeScreenshotComparator.Result.Match, result)
    } finally {
      runtime?.close()
      scope.cancel()
    }
  }
}
