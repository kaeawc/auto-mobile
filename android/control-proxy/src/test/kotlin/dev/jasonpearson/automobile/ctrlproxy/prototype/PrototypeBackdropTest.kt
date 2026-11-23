package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.WindowManager.LayoutParams
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.ctrlproxy.prototypeResultFrame
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * `window.backdrop` on Android (#15126): API 31+ card blur or blur-behind, with a tonal fallback
 * when blur is unavailable and the applied mode reported in the show result.
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
  fun `sheet blur leaves its size edge and keyboard lift intact`() {
    val params =
      prototypeLayoutParams(
        PrototypePlacement.Sheet(PrototypePlacement.Edge.BOTTOM, 120f),
        true,
        2f,
        33,
        imeLiftPx = 64,
        blurBehindRadiusPx = 32,
      )
    assertEquals(LayoutParams.MATCH_PARENT, params.width)
    assertEquals(240, params.height)
    assertEquals(Gravity.BOTTOM, params.gravity)
    assertEquals(64, params.y)
    assertEquals(LayoutParams.SOFT_INPUT_ADJUST_NOTHING, params.softInputMode)
    assertTrue(params.flags and LayoutParams.FLAG_BLUR_BEHIND != 0)
    assertEquals(32, params.blurBehindRadius)
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

  @Test
  fun `floating blur attaches a rounded card and transfers touch through to its window`() =
    runTest {
      val harness = CardHarness()
      harness.controller.show("a", floatingSpec())
      val card = harness.cards.windows.single()
      assertEquals(listOf("blur"), harness.noted)
      assertEquals(32, card.blur.radiusPx)
      assertEquals(36f, card.blur.cornerRadiusPx(200, 160), 0f)
      assertEquals(LayoutParams.WRAP_CONTENT, card.params.width)
      assertEquals(LayoutParams.WRAP_CONTENT, card.params.height)
      assertEquals(Gravity.CENTER, card.params.gravity)
      assertEquals(4, card.params.x)
      assertEquals(-6, card.params.y)
      assertEquals(PrototypeWindowLayer.SYSTEM.windowType, card.params.type)
      assertTrue(card.params.flags and LayoutParams.FLAG_NOT_TOUCH_MODAL != 0)
      assertTrue(card.params.flags and LayoutParams.FLAG_NOT_FOCUSABLE != 0)
      assertEquals(0, card.params.flags and LayoutParams.FLAG_BLUR_BEHIND)
      assertTrue(harness.manager.added.isEmpty())

      harness.host.withTouchThrough {
        assertTrue(card.params.flags and LayoutParams.FLAG_NOT_TOUCHABLE != 0)
      }
      assertEquals(0, card.params.flags and LayoutParams.FLAG_NOT_TOUCHABLE)
      assertTrue(harness.host.setStackBackEnabled(true))
      assertEquals(0, card.params.flags and LayoutParams.FLAG_NOT_FOCUSABLE)
      assertTrue(card.params.flags and LayoutParams.FLAG_ALT_FOCUSABLE_IM != 0)
      assertTrue(harness.host.setTextFieldVisible(true))
      assertEquals(0, card.params.flags and LayoutParams.FLAG_ALT_FOCUSABLE_IM)
      assertTrue(card.params.flags and LayoutParams.FLAG_NOT_TOUCH_MODAL != 0)
    }

  @Test
  fun `failed card attach draws and reports fallback without blur behind`() = runTest {
    val harness = CardHarness()
    harness.cards.failAttach = true
    harness.controller.show("a", floatingSpec())
    assertEquals(listOf("fallback"), harness.noted)
    assertEquals(PrototypeBackdropMode.FALLBACK, harness.host.appliedBackdrop)
    assertEquals(1, harness.cards.attempts)
    assertEquals(0, harness.manager.added.single().flags and LayoutParams.FLAG_BLUR_BEHIND)
  }

  @Test
  fun `replacing or dismissing a card releases its own window`() = runTest {
    val harness = CardHarness()
    harness.controller.show("a", floatingSpec())
    val first = harness.cards.windows.single()
    harness.controller.show("b", floatingSpec(cornerDp = 12.0))
    assertTrue(first.removed)
    val second = harness.cards.windows.last()
    assertEquals(24f, second.blur.cornerRadiusPx(200, 160), 0f)
    assertFalse(second.removed)
    assertTrue(harness.host.dismiss())
    assertTrue(second.removed)
    assertFalse(harness.host.isShowing)
  }

  @Test
  fun `a runtime change to the root radius reshapes the card window only when it changes`() =
    runTest {
      val harness = CardHarness()
      harness.controller.show("a", reshapingSpec())
      val runtime = checkNotNull(harness.controller.activeRuntime)
      val first = harness.cards.windows.single()
      assertEquals(36f, first.blur.cornerRadiusPx(200, 160), 0f)

      harness.controller.interact(runtime, PrototypeInteraction.Toggle("other"))
      assertEquals(1, harness.cards.windows.size)
      assertFalse(first.removed)

      harness.controller.interact(runtime, PrototypeInteraction.Toggle("flat"))
      assertTrue(first.removed)
      val flat = harness.cards.windows.last()
      assertEquals(2, harness.cards.windows.size)
      assertEquals(0f, flat.blur.cornerRadiusPx(200, 160), 0f)
      assertFalse(flat.removed)

      harness.controller.interact(runtime, PrototypeInteraction.Toggle("other"))
      assertEquals(2, harness.cards.windows.size)
      assertFalse(flat.removed)
    }

  @Test
  fun `a card blur fallback is recorded and blur is retried only on a reshape`() = runTest {
    val harness = Harness(sdk = 34, blurEnabled = true)
    val host = harness.host
    host.fallBackFromBlur = true
    harness.controller.show("a", reshapingSpec())
    assertEquals(listOf("fallback"), harness.noted)
    val runtime = checkNotNull(harness.controller.activeRuntime)

    harness.controller.interact(runtime, PrototypeInteraction.Toggle("other"))
    assertEquals(1, host.requests.size)

    // A detached window is restored with the backdrop the host drew, not the failed card blur.
    host.isShowing = false
    harness.controller.onDisplayTransition(0, removed = false)
    assertEquals(PrototypeBackdropMode.FALLBACK, host.requests.last().backdrop?.mode)

    // A reshape asks for the authored blur again.
    host.fallBackFromBlur = false
    harness.controller.interact(runtime, PrototypeInteraction.Toggle("flat"))
    val reshaped = host.requests.last()
    assertEquals(PrototypeBackdropMode.BLUR, reshaped.backdrop?.mode)
    assertEquals(RoundedCornerShape(0.dp), reshaped.backdropShape)
    val count = host.requests.size

    harness.controller.interact(runtime, PrototypeInteraction.Toggle("other"))
    assertEquals(count, host.requests.size)
  }

  @Test
  fun `sheet and fullscreen blur use the existing window manager`() = runTest {
    val harness = CardHarness()
    val plan = PrototypeBackdropPlan(PrototypeBackdropMode.BLUR, 16, null)
    val sheet = PrototypePlacement.Sheet(PrototypePlacement.Edge.BOTTOM, 120f)
    assertTrue(harness.host.show(PrototypeRequest(sheet, backdrop = plan)))
    assertEquals(32, harness.manager.added.single().blurBehindRadius)
    assertTrue(
      harness.host.replace(PrototypeRequest(PrototypePlacement.Fullscreen(), backdrop = plan)),
    )
    val params = harness.manager.updated.last()
    assertTrue(params.flags and LayoutParams.FLAG_BLUR_BEHIND != 0)
    assertEquals(32, params.blurBehindRadius)
    assertEquals(0, harness.cards.attempts)
  }

  @Test
  fun `floating blur defaults to square and rejects unequal radii`() {
    val request =
      PrototypeRequest(backdrop = PrototypeBackdropPlan(PrototypeBackdropMode.BLUR, 16, null))
    val blur = checkNotNull(request.floatingCardBlur(2f, 34))
    assertEquals(0f, blur.cornerRadiusPx(200, 160), 0f)
    val unequal = request.copy(backdropShape = RoundedCornerShape(topStart = 18.dp))
    assertNull(unequal.floatingCardBlur(2f, 34))
  }

  /** A floating card whose root radius drops to 0 while `flat` is on; `other` changes nothing. */
  private fun reshapingSpec(): PrototypeSpec {
    val base = floatingSpec()
    val root = base.root as PrototypeBoxNode
    return base.copy(
      state =
        mapOf(
          "flat" to PrototypeScalar.BooleanValue(false),
          "other" to PrototypeScalar.BooleanValue(false),
        ),
      root =
        root.copy(
          styleWhen =
            listOf(
              PrototypeStyleWhen(
                PrototypeCondition(key = "flat", equals = PrototypeScalar.BooleanValue(true)),
                PrototypeStyle(cornerRadius = PrototypeCornerRadius.Dp(0.0)),
              ),
            ),
        ),
    )
  }

  private fun floatingSpec(cornerDp: Double = 18.0) =
    PrototypeSpec(
      "card",
      PrototypeWindow(
        PrototypeFloatingPlacement("center", PrototypeOffset(2.0, -3.0)),
        backdrop = thin,
        transition = "none",
      ),
      root =
        PrototypeBoxNode(
          style = PrototypeStyle(cornerRadius = PrototypeCornerRadius.Dp(cornerDp)),
          children = listOf(PrototypeSpacerNode()),
        ),
    )

  private class CardHarness {
    private val main = FakePrototypeMainThread()
    val manager = RecordingPrototypeWindowManager(main, mutableListOf())
    val cards = FakeCardBlurHost()
    val noted = mutableListOf<String>()
    val host =
      DefaultPrototypeHost(
        RuntimeEnvironment.getApplication(),
        manager,
        mainThread = main,
        densityProvider = { 2f },
        settleTimer = FakePrototypeSettleTimer(mutableListOf()),
        backScope = CoroutineScope(UnconfinedTestDispatcher()),
        firstRenderWaiter = PrototypeFirstRenderWaiter { _, _ -> true },
        cardBlurHost = cards,
      )
    val controller =
      PrototypeController(
        host,
        object : PrototypeResultSink {
          override suspend fun send(requestId: String?, success: Boolean, error: String?) {
            assertTrue(error, success)
          }

          override fun noteShownBackdrop(requestId: String?, backdrop: String) {
            noted += backdrop
          }
        },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
        backdropSupport = PrototypeBackdropSupport { true },
        sdkInt = 34,
      )
  }

  private class FakeCardBlurHost : PrototypeCardBlurHost {
    var failAttach = false
    var attempts = 0
    val windows = mutableListOf<FakeCardWindow>()

    override fun attach(
      context: Context,
      view: View,
      params: LayoutParams,
      blur: PrototypeCardBlur,
    ): PrototypeCardBlurWindow {
      attempts++
      check(!failAttach)
      return FakeCardWindow(View(context), params, blur).also(windows::add)
    }
  }

  private class FakeCardWindow(
    override val decor: View,
    var params: LayoutParams,
    val blur: PrototypeCardBlur,
  ) : PrototypeCardBlurWindow {
    var removed = false

    override fun update(params: LayoutParams) {
      check(!removed)
      this.params = params
    }

    override fun remove() {
      check(!removed)
      removed = true
    }
  }
}
