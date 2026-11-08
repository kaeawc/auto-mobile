package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.pm.ActivityInfo
import android.view.View
import android.view.WindowManager.LayoutParams
import androidx.compose.ui.platform.ComposeView
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeWindowControlsTest {
  private val scope = TestScope()
  private val main = FakePrototypeMainThread()
  private val history = mutableListOf<String>()
  private val manager = RecordingPrototypeWindowManager(main, history)
  private val controls = FakeWindowControls()
  private val keyboard = FakeKeyboard()
  private val timer = FakePrototypeSettleTimer(history).apply { gate = CompletableDeferred() }
  private var rendered = true
  private lateinit var host: DefaultPrototypeHost

  @Before
  fun setUp() {
    ComposeView(RuntimeEnvironment.getApplication())
    host =
      DefaultPrototypeHost(
        RuntimeEnvironment.getApplication(),
        manager,
        mainThread = main,
        settleTimer = timer,
        backScope = scope,
        isViewAttached = manager::isViewAttached,
        firstRenderWaiter = PrototypeFirstRenderWaiter { _, _ -> rendered },
        windowControls = controls,
        keyboard = keyboard,
      )
  }

  @Test
  fun `show applies window local controls and relayout preserves them`() = runTest {
    val values = PrototypeWindowControls(true, 0.25f, "portrait", "dark")
    assertTrue(host.show(PrototypeRequest(windowControls = values)))
    assertControls(manager.added.single(), true, 0.25f, ActivityInfo.SCREEN_ORIENTATION_PORTRAIT)
    assertEquals(listOf(values), controls.applied)
    assertTrue(host.setTextFieldVisible(true))
    assertTrue(host.relayout())
    assertControls(manager.updated.last(), true, 0.25f, ActivityInfo.SCREEN_ORIENTATION_PORTRAIT)
    assertTrue(manager.updated.last().flags and LayoutParams.FLAG_NOT_FOCUSABLE == 0)
    assertEquals(values, controls.applied.last())
  }

  @Test
  fun `replace keeps identical controls and changes or clears every value`() = runTest {
    val original = PrototypeWindowControls(true, 0f, "portrait", "dark")
    host.show(PrototypeRequest(windowControls = original))
    val view = manager.view
    host.replace(PrototypeRequest(windowControls = original))
    assertSame(view, manager.view)
    assertControls(manager.updated.last(), true, 0f, ActivityInfo.SCREEN_ORIENTATION_PORTRAIT)
    host.replace(
      PrototypeRequest(windowControls = PrototypeWindowControls(false, 1f, "landscape", "light")),
    )
    assertControls(manager.updated.last(), false, 1f, ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE)
    host.replace(
      PrototypeRequest(
        windowControls = PrototypeWindowControls(orientation = "unlocked", statusBar = "auto"),
      ),
    )
    assertControls(
      manager.updated.last(),
      false,
      LayoutParams.BRIGHTNESS_OVERRIDE_NONE,
      ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED,
    )
    host.replace(PrototypeRequest())
    assertControls(
      manager.updated.last(),
      false,
      LayoutParams.BRIGHTNESS_OVERRIDE_NONE,
      ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED,
    )
    assertEquals(PrototypeWindowControls(), controls.applied.last())
    assertEquals(1, manager.added.size)
  }

  @Test
  fun `dismiss releases the owning overlay and next show starts with system defaults`() = runTest {
    host.show(PrototypeRequest(windowControls = PrototypeWindowControls(true, 0.8f, "landscape")))
    val view = checkNotNull(manager.view)
    assertTrue(host.dismiss())
    assertFalse(manager.isViewAttached(view))
    assertFalse(host.isShowing)
    host.show()
    assertControls(
      manager.added.last(),
      false,
      LayoutParams.BRIGHTNESS_OVERRIDE_NONE,
      ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED,
    )
  }

  @Test
  fun `animated dismissal releases controls before waiting for the exit timer`() = scope.runTest {
    host.show(
      PrototypeRequest(
        transition = "fade",
        windowControls = PrototypeWindowControls(true, 0.8f, "portrait"),
      ),
    )
    assertTrue(host.dismiss())
    assertFalse(host.isShowing)
    assertEquals(0, manager.removals)
    assertControls(
      manager.updated.last(),
      false,
      LayoutParams.BRIGHTNESS_OVERRIDE_NONE,
      ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED,
    )
    assertEquals(listOf(400L), timer.waits)
    timer.gate?.complete(Unit)
    runCurrent()
    assertEquals(1, manager.removals)
  }

  @Test
  fun `failed replacement restores the previous control values`() = runTest {
    host.show(PrototypeRequest(windowControls = PrototypeWindowControls(true, 0.6f, "portrait")))
    rendered = false
    val error = runCatching { host.replace(PrototypeRequest()) }.exceptionOrNull()
    assertTrue(error is PrototypeRenderFailedException)
    assertTrue(host.isShowing)
    assertControls(manager.updated.last(), true, 0.6f, ActivityInfo.SCREEN_ORIENTATION_PORTRAIT)
    host.relayout()
    assertControls(manager.updated.last(), true, 0.6f, ActivityInfo.SCREEN_ORIENTATION_PORTRAIT)
  }

  @Test
  fun `status bar styles never change layout params or unrelated flags`() {
    val params = LayoutParams().apply { flags = LayoutParams.FLAG_NOT_TOUCHABLE }
    AndroidPrototypeWindowControlApplier.apply(params, PrototypeWindowControls())
    val original = LayoutParams().apply { copyFrom(params) }
    for (style in listOf("light", "dark", "auto")) {
      val requested = PrototypeWindowControls(statusBar = style)
      AndroidPrototypeWindowControlApplier.apply(params, requested)
      assertEquals(0, original.copyFrom(params))
      assertEquals("unsupported", requested.statusBarSupport)
    }
    assertEquals(LayoutParams.FLAG_NOT_TOUCHABLE, params.flags)
    assertNull(PrototypeWindowControls().statusBarSupport)
  }

  @Test
  fun `hide keyboard uses the current view and hides before clearing focus on main`() = runTest {
    host.hideKeyboard()
    assertTrue(keyboard.calls.isEmpty())
    host.show(PrototypeRequest(hasTextField = true, hasStackBack = true))
    val view = checkNotNull(manager.view)
    keyboard.focused += view
    host.hideKeyboard()
    assertEquals(listOf("hide", "clear"), keyboard.calls)
    assertEquals(listOf(view, view), keyboard.views)
    assertFalse(view in keyboard.focused)
    // Dismiss the IME without making navigation or a still-visible field unfocusable.
    assertTrue(manager.added.single().flags and LayoutParams.FLAG_NOT_FOCUSABLE == 0)
    assertTrue(manager.updated.isEmpty())
    host.dismiss()
    host.hideKeyboard()
    assertEquals(2, keyboard.calls.size)
  }

  @Test
  fun `field disappearance reuses the same keyboard hide and focus clear path`() = runTest {
    host.show(PrototypeRequest(hasTextField = true))
    keyboard.focused += checkNotNull(manager.view)
    host.setTextFieldVisible(false)
    assertEquals(listOf("hide", "clear"), keyboard.calls)
    assertTrue(keyboard.focused.isEmpty())
    assertTrue(manager.updated.last().flags and LayoutParams.FLAG_NOT_FOCUSABLE != 0)
  }

  private fun assertControls(
    params: LayoutParams,
    keep: Boolean,
    brightness: Float,
    orientation: Int,
  ) {
    assertEquals(keep, params.flags and LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
    assertEquals(brightness, params.screenBrightness, 0f)
    assertEquals(orientation, params.screenOrientation)
  }

  private class FakeWindowControls : PrototypeWindowControlApplier {
    val applied = mutableListOf<PrototypeWindowControls>()

    override fun apply(params: LayoutParams, controls: PrototypeWindowControls) {
      applied += controls
      AndroidPrototypeWindowControlApplier.apply(params, controls)
    }
  }

  private inner class FakeKeyboard : PrototypeKeyboard {
    val calls = mutableListOf<String>()
    val views = mutableListOf<View>()
    val focused = mutableSetOf<View>()

    override fun hideIme(view: View) {
      assertTrue(main.isMainThread())
      assertTrue(view in focused)
      calls += "hide"
      views += view
    }

    override fun clearFocus(view: View) {
      assertTrue(main.isMainThread())
      calls += "clear"
      views += view
      focused -= view
    }
  }

  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      runTest {}
      PrototypeRequest()
    }
  }
}
