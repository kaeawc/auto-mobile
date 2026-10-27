package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.WindowManager
import dev.jasonpearson.automobile.ctrlproxy.prototypeResultFrame
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * `window.backdrop` on Android (#15126): API 31+ blur-behind with a tonal fallback below it or when
 * cross-window blur is off, the outcome reported in the show result. Node-level `surface: "glass"`
 * (#15256) reuses [PrototypeBackdrops].
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrototypeBackdropTest {
  private val thin = PrototypeBackdrop(material = "thin")

  @Test
  fun `blur needs API 31 and cross-window blur`() {
    assertEquals(
      PrototypeBackdropMode.BLUR,
      PrototypeBackdrops.plan(thin, sdkInt = 31, crossWindowBlurEnabled = true).mode,
    )
    assertEquals(
      PrototypeBackdropMode.FALLBACK,
      PrototypeBackdrops.plan(thin, sdkInt = 30, crossWindowBlurEnabled = true).mode,
    )
    assertEquals(
      PrototypeBackdropMode.FALLBACK,
      PrototypeBackdrops.plan(thin, sdkInt = 34, crossWindowBlurEnabled = false).mode,
    )
  }

  @Test
  fun `glass is iOS only so Android always falls back for it`() {
    val plan =
      PrototypeBackdrops.plan(PrototypeBackdrop("glass"), 34, crossWindowBlurEnabled = true)
    assertEquals(PrototypeBackdropMode.FALLBACK, plan.mode)
  }

  @Test
  fun `the radius is the authored blur or the material's own`() {
    assertEquals(16, PrototypeBackdrops.plan(thin, 34, true).radiusDp)
    assertEquals(8, PrototypeBackdrops.plan(PrototypeBackdrop("ultraThin"), 34, true).radiusDp)
    assertEquals(40, PrototypeBackdrops.plan(PrototypeBackdrop("thick"), 34, true).radiusDp)
    assertEquals(
      150,
      PrototypeBackdrops.plan(PrototypeBackdrop("thin", blur = 150), 34, true).radiusDp,
    )
    assertEquals(0, PrototypeBackdrops.plan(PrototypeBackdrop("thin", blur = 0), 34, true).radiusDp)
    assertEquals(
      "surface",
      PrototypeBackdrops.plan(PrototypeBackdrop("thin", tint = "surface"), 34, true).tint,
    )
  }

  private fun params(radiusPx: Int, sdk: Int) =
    prototypeLayoutParams(
      PrototypePlacement.Fullscreen(androidx.compose.ui.graphics.Color.Black),
      false,
      2f,
      sdk,
      blurBehindRadiusPx = radiusPx,
    )

  @Test
  fun `the window asks for blur behind only on API 31 and up with a radius`() {
    val blurred = params(32, 31)
    assertTrue(blurred.flags and WindowManager.LayoutParams.FLAG_BLUR_BEHIND != 0)
    assertEquals(32, blurred.blurBehindRadius)
    assertEquals(0, params(32, 30).flags and WindowManager.LayoutParams.FLAG_BLUR_BEHIND)
    assertEquals(0, params(0, 34).flags and WindowManager.LayoutParams.FLAG_BLUR_BEHIND)
  }

  @Test
  fun `only a real-blur plan has a window blur radius`() {
    val blur =
      PrototypeRequest(backdrop = PrototypeBackdropPlan(PrototypeBackdropMode.BLUR, 16, null))
    val fallback =
      PrototypeRequest(backdrop = PrototypeBackdropPlan(PrototypeBackdropMode.FALLBACK, 16, null))
    assertEquals(32, backdropBlurPx(blur, 2f))
    assertEquals(0, backdropBlurPx(fallback, 2f))
    assertEquals(0, backdropBlurPx(PrototypeRequest(), 2f))
  }

  @Test
  fun `the show result frame carries the outcome and omits it otherwise`() {
    assertTrue(
      prototypeResultFrame("r", true, null, backdrop = "blur").contains("\"backdrop\":\"blur\""),
    )
    assertFalse(prototypeResultFrame("r", true, null).contains("backdrop"))
  }

  private class Harness(sdk: Int, blurEnabled: Boolean) {
    val host = FakePrototypeHost()
    val noted = mutableListOf<String>()
    val sink =
      object : PrototypeResultSink {
        override suspend fun send(requestId: String?, success: Boolean, error: String?) = Unit

        override fun noteShownBackdrop(requestId: String?, backdrop: String) {
          noted += backdrop
        }
      }
    val controller =
      PrototypeController(
        host,
        sink,
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
        backdropSupport = PrototypeBackdropSupport { blurEnabled },
        sdkInt = sdk,
      )

    fun spec(backdrop: PrototypeBackdrop?) =
      PrototypeSpec(
        "panel",
        PrototypeWindow(PrototypeFullscreenPlacement(), backdrop = backdrop),
        root = PrototypeSpacerNode(),
      )
  }

  @Test
  fun `a show reports blur or fallback and attaches the plan to the host request`() = runTest {
    val blurred = Harness(sdk = 34, blurEnabled = true)
    blurred.controller.show("a", blurred.spec(thin))
    assertEquals(listOf("blur"), blurred.noted)
    assertEquals(PrototypeBackdropMode.BLUR, blurred.host.requests.last().backdrop?.mode)

    val tonal = Harness(sdk = 30, blurEnabled = true)
    tonal.controller.show("a", tonal.spec(thin))
    assertEquals(listOf("fallback"), tonal.noted)

    val disabled = Harness(sdk = 34, blurEnabled = false)
    disabled.controller.show("a", disabled.spec(thin))
    assertEquals(listOf("fallback"), disabled.noted)
  }

  @Test
  fun `a show without a backdrop reports nothing`() = runTest {
    val plain = Harness(sdk = 34, blurEnabled = true)
    plain.controller.show("a", plain.spec(null))
    assertEquals(emptyList<String>(), plain.noted)
    assertNull(plain.host.requests.last().backdrop)
  }
}
