package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A prototype follows the app it was shown over (#10261). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeForegroundTest {
  private val app = AccessibilityWindowInfo.TYPE_APPLICATION
  private val ime = AccessibilityWindowInfo.TYPE_INPUT_METHOD
  private val system = AccessibilityWindowInfo.TYPE_SYSTEM
  private val a11yOverlay = AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY

  private val host = FakePrototypeHost()
  private val timer = FakePrototypeTimer()
  private val events = mutableListOf<PrototypeEvent>()
  private val statuses = mutableListOf<List<PrototypeStatusEntry>>()
  private var detached = 0
  private var foreground: String? = "com.example.app"
  private lateinit var controller: PrototypeController
  private val tracker =
    PrototypeForegroundTracker(
      timer,
      ownPackage = "dev.jasonpearson.automobile.ctrlproxy",
      foregroundNow = { foreground },
      onChanged = { controller.onConfigurationChanged() },
    )

  init {
    controller =
      PrototypeController(
        host,
        object : PrototypeResultSink {
          override suspend fun send(requestId: String?, success: Boolean, error: String?) = Unit

          override suspend fun sendPrototypeStatus(
            requestId: String?,
            prototypes: List<PrototypeStatusEntry>,
            droppedEvents: Long,
          ) {
            statuses += prototypes
          }
        },
        onDismissed = { detached++ },
        eventSink = PrototypeEventSink { events += it },
        clock = { timer.now },
        // Mirrors CtrlProxy: the lock-screen check is false here, suspension alone blocks.
        lifecycle = PrototypeLifecycle(timer, isBlocked = { tracker.suspended }),
        foreground = tracker,
      )
  }

  private fun spec(id: String = "panel") =
    PrototypeSpec(
      id,
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = PrototypeTextNode(text = "panel"),
      state = mapOf("count" to PrototypeScalar.Numeric(3.0)),
    )

  private suspend fun settle() = timer.advance(PROTOTYPE_FOREGROUND_DEBOUNCE_MILLIS)

  private suspend fun status(): PrototypeStatusEntry {
    controller.inspect("inspect")
    return statuses.last().single()
  }

  @Test
  fun `leaving the app hides the prototype keeping state and returning restores it`() = runTest {
    controller.show("s", spec())
    assertTrue(host.isShowing)

    tracker.onWindowEvent("com.android.settings", app)
    settle()
    assertFalse(host.isShowing)
    assertTrue(controller.isSuspendedByForeground)
    assertTrue(status().suspended)
    assertEquals(PrototypeScalar.Numeric(3.0), status().state["count"])
    assertTrue(
      "no dismissed event for a temporary hide",
      events.none { it.kind == PrototypeEventKind.DISMISSED },
    )

    tracker.onWindowEvent("com.example.app", app)
    settle()
    assertTrue(host.isShowing)
    assertFalse(controller.isSuspendedByForeground)
    assertFalse(status().suspended)
    assertEquals(PrototypeScalar.Numeric(3.0), status().state["count"])
    assertTrue(events.none { it.kind == PrototypeEventKind.DISMISSED })
  }

  @Test
  fun `a capture while suspended treats the prototype as not showing and never re-shows it`() =
    runTest {
      controller.show("s", spec())
      tracker.onWindowEvent("com.android.settings", app)
      settle()
      assertTrue(controller.isSuspendedByForeground)
      val calls = host.calls.size

      val capture = controller.withHiddenForCapture { "pixels" }

      assertEquals(PrototypeHiddenCapture("pixels", prototypeExcluded = true), capture)
      // Neither a capture hide nor a restore reached the host: the prototype stays hidden.
      assertEquals(calls, host.calls.size)
      assertFalse(host.isShowing)
      assertTrue(controller.isSuspendedByForeground)
    }

  @Test
  fun `a capture while the app is in front hides through the host`() = runTest {
    controller.show("s", spec())
    controller.withHiddenForCapture { "pixels" }
    assertEquals("hideForCapture", host.calls.last())
  }

  @Test
  fun `notification shade and system dialogs do not hide the prototype`() = runTest {
    controller.show("s", spec())
    tracker.onWindowEvent("com.android.systemui", app)
    tracker.onWindowEvent("com.android.systemui", system)
    tracker.onWindowEvent("com.google.android.permissioncontroller", app)
    tracker.onWindowEvent("android", app)
    settle()
    assertTrue(host.isShowing)
    assertFalse(status().suspended)
  }

  @Test
  fun `the keyboard and the prototype's own windows do not hide the prototype`() = runTest {
    controller.show("s", spec())
    tracker.onWindowEvent("com.google.android.inputmethod.latin", ime)
    tracker.onWindowEvent("dev.jasonpearson.automobile.ctrlproxy", ime)
    tracker.onWindowEvent("dev.jasonpearson.automobile.ctrlproxy", a11yOverlay)
    tracker.onWindowEvent("dev.jasonpearson.automobile.ctrlproxy", app)
    tracker.onWindowEvent("com.example.other", null)
    settle()
    assertTrue(host.isShowing)
    assertFalse(controller.isSuspendedByForeground)
  }

  @Test
  fun `a dialog of the same app does not hide the prototype`() = runTest {
    controller.show("s", spec())
    tracker.onWindowEvent("com.example.app", app)
    settle()
    assertTrue(host.isShowing)
  }

  @Test
  fun `a flicker shorter than the debounce does not hide or re-show`() = runTest {
    controller.show("s", spec())
    val calls = host.calls.size
    tracker.onWindowEvent("com.android.settings", app)
    timer.advance(PROTOTYPE_FOREGROUND_DEBOUNCE_MILLIS - 1)
    tracker.onWindowEvent("com.example.app", app)
    settle()
    assertTrue(host.isShowing)
    assertEquals(calls, host.calls.size)
  }

  @Test
  fun `dismissing while suspended releases the anchor`() = runTest {
    controller.show("s", spec())
    tracker.onWindowEvent("com.android.settings", app)
    settle()
    controller.dismiss("d", "panel", null)
    assertFalse(tracker.suspended)
    tracker.onWindowEvent("com.example.app", app)
    settle()
    assertFalse(host.isShowing)
  }

  @Test
  fun `a new show re-anchors to the app now in front`() = runTest {
    controller.show("s", spec())
    tracker.onWindowEvent("com.android.settings", app)
    settle()
    assertTrue(tracker.suspended)

    foreground = "com.android.settings"
    controller.show("s2", spec("second"))
    assertTrue(host.isShowing)
    assertFalse(tracker.suspended)
    tracker.onWindowEvent("com.android.settings", app)
    settle()
    assertTrue(host.isShowing)
  }

  @Test
  fun `a rejected show keeps the previous prototype suspended and anchored`() = runTest {
    controller.show("s", spec())
    tracker.onWindowEvent("com.android.settings", app)
    settle()
    assertTrue(tracker.suspended)

    foreground = "com.android.settings"
    host.accept = false
    try {
      controller.show("s2", spec("second"))
    } catch (_: Exception) {}
    host.accept = true

    assertTrue("the previous prototype stays suspended", tracker.suspended)
    assertTrue(controller.isSuspendedByForeground)
    // Still anchored to the original app: Settings in front does not draw the prototype.
    host.calls.clear()
    tracker.onWindowEvent("com.android.settings", app)
    settle()
    controller.onConfigurationChanged()
    assertFalse(host.isShowing)
    assertTrue(host.calls.none { it == "show" || it == "replace" })

    tracker.onWindowEvent("com.example.app", app)
    settle()
    assertTrue(host.isShowing)
  }

  @Test
  fun `an unknown foreground leaves the prototype unscoped`() = runTest {
    foreground = null
    controller.show("s", spec())
    tracker.onWindowEvent("com.android.settings", app)
    settle()
    assertTrue(host.isShowing)
  }

  @Test
  fun `only application windows outside the ignore set pick the foreground`() {
    val own = "dev.jasonpearson.automobile.ctrlproxy"
    assertEquals("com.example.app", prototypeForegroundCandidate("com.example.app", app, own))
    assertNull(prototypeForegroundCandidate("com.example.app", ime, own))
    assertNull(prototypeForegroundCandidate("com.example.app", system, own))
    assertNull(prototypeForegroundCandidate("com.example.app", a11yOverlay, own))
    assertNull(prototypeForegroundCandidate("com.example.app", null, own))
    assertNull(prototypeForegroundCandidate(null, app, own))
    assertNull(prototypeForegroundCandidate(own, app, own))
    PROTOTYPE_FOREGROUND_IGNORED_PACKAGES.forEach {
      assertNull(prototypeForegroundCandidate(it, app, own))
    }
  }

  @Test
  fun `the foreground comes from the active qualifying application window`() {
    val own = "dev.jasonpearson.automobile.ctrlproxy"
    val windows =
      listOf(
        PrototypeForegroundWindow(system, false, "com.android.systemui"),
        PrototypeForegroundWindow(ime, false, "com.keyboard"),
        PrototypeForegroundWindow(app, false, "com.example.top"),
        PrototypeForegroundWindow(app, true, "com.example.active"),
      )
    assertEquals("com.example.active", prototypeForegroundFromWindows(windows, own))
    assertEquals(
      "com.example.top",
      prototypeForegroundFromWindows(windows.map { it.copy(active = false) }, own),
    )
    assertNull(prototypeForegroundFromWindows(windows.take(2), own))
  }
}
