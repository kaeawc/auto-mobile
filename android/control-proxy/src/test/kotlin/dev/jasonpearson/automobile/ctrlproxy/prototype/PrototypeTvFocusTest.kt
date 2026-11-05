package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.pm.PackageManager
import android.view.KeyEvent
import android.view.WindowManager.LayoutParams
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeTvFocusTest {
  @Test
  fun `button only TV overlay takes key focus through show replace and relayout`() =
    verifyFocus(true)

  @Test
  fun `non TV overlay keeps its existing text field and stack focus policy`() = verifyFocus(false)

  private fun verifyFocus(tv: Boolean) = runTest {
    val context = RuntimeEnvironment.getApplication()
    shadowOf(context.packageManager).setSystemFeature(PackageManager.FEATURE_LEANBACK, tv)
    val main = FakePrototypeMainThread()
    val manager = RecordingPrototypeWindowManager(main, mutableListOf())
    var dismissed = 0
    val host =
      DefaultPrototypeHost(
        context,
        manager,
        mainThread = main,
        sdkInt = 30,
        densityProvider = { 1f },
        displayWindows =
          PrototypeDisplayWindows { _, _ ->
            PrototypeDisplayWindow(context, manager, density = { 1f })
          },
        isViewAttached = manager::isViewAttached,
        firstRenderWaiter = PrototypeFirstRenderWaiter { _, _ -> true },
        backScope = this,
      )
    val request = PrototypeRequest(onHostDismiss = { dismissed++ })
    try {
      for (layer in PrototypeWindowLayer.entries) {
        assertTrue(host.show(request.copy(layer = layer)))
        assertKeyFocus(manager.added.last(), tv)
        assertTrue(host.replace(request.copy(layer = layer)))
        assertKeyFocus(manager.updated.last(), tv)
        assertTrue(host.setTextFieldVisible(true))
        assertKeyFocus(manager.updated.last(), true)
        assertTrue(host.setTextFieldVisible(false))
        assertKeyFocus(manager.updated.last(), tv)
        assertTrue(host.setStackBackEnabled(true))
        assertKeyFocus(manager.updated.last(), true)
        assertTrue(host.setStackBackEnabled(false))
        assertTrue(host.relayout())
        assertKeyFocus(manager.updated.last(), tv)
        val view = checkNotNull(manager.view)
        assertEquals(
          tv,
          view.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK)),
        )
        assertEquals(tv, view.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK)))
        runCurrent()
        assertTrue(host.dismiss())
      }
      assertEquals(if (tv) PrototypeWindowLayer.entries.size else 0, dismissed)
    } finally {
      host.destroy()
    }
  }

  private fun assertKeyFocus(params: LayoutParams, expected: Boolean) {
    assertEquals(
      if (expected) 0 else LayoutParams.FLAG_NOT_FOCUSABLE,
      params.flags and LayoutParams.FLAG_NOT_FOCUSABLE,
    )
    assertTrue(params.flags and LayoutParams.FLAG_NOT_TOUCH_MODAL != 0)
  }
}
