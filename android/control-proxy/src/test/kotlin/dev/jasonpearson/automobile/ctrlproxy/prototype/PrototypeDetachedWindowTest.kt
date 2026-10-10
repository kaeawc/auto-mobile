package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.KeyEvent
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Controller lifecycle against the real host when the platform reports the window already detached:
 * every path must still end in exactly one `dismissed` event and the highlight-restore callback.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeDetachedWindowTest {
  private val history = mutableListOf<String>()
  private val events = mutableListOf<PrototypeEvent>()
  private val results = mutableListOf<Pair<Boolean, String?>>()
  private val timer = FakePrototypeTimer()
  private var blocked = false
  private val blockedScript = ArrayDeque<Boolean>()
  private var detached = 0
  private var lost = 0
  private lateinit var main: FakePrototypeMainThread
  private lateinit var manager: RecordingPrototypeWindowManager
  private lateinit var host: DefaultPrototypeHost
  private lateinit var controller: PrototypeController

  /** Scripted reads let a test flip the lock between the controller's and the host's checks. */
  private fun isBlocked() = blockedScript.removeFirstOrNull() ?: blocked

  @Before
  fun setUp() {
    main = FakePrototypeMainThread()
    manager = RecordingPrototypeWindowManager(main, history)
    host =
      DefaultPrototypeHost(
        RuntimeEnvironment.getApplication(),
        manager,
        sdkInt = 30,
        mainThread = main,
        settleTimer = FakePrototypeSettleTimer(history),
        densityProvider = { 2.5f },
        onWindowLost = { lost++ },
        isBlocked = ::isBlocked,
        backScope = CoroutineScope(Dispatchers.Unconfined),
      )
    controller =
      PrototypeController(
        host,
        PrototypeResultSink { _, success, error -> results += success to error },
        onDismissed = { detached++ },
        eventSink = PrototypeEventSink { events += it },
        clock = { timer.now },
        lifecycle = PrototypeLifecycle(timer, TTL, isBlocked = ::isBlocked),
      )
  }

  private fun spec() =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = PrototypeTextNode(text = "panel"),
    )

  private fun detachPlatformWindow() {
    manager.failUpdate = true
    manager.updateFailure = IllegalArgumentException("View not attached to window manager")
    manager.failRemove = true
    manager.removeFailure = IllegalArgumentException("View not attached to window manager")
  }

  private fun assertSingleDismiss(reason: String, sequence: Long = 1L) {
    val dismissals = events.filter { it.kind == PrototypeEventKind.DISMISSED }
    assertEquals(1, dismissals.size)
    assertEquals(Json.parseToJsonElement("""{"reason":"$reason"}"""), dismissals.single().payload)
    assertEquals(sequence, dismissals.single().sequence)
  }

  private suspend fun assertNoFurtherEvents() {
    val size = events.size
    controller.onConfigurationChanged()
    controller.onClientCountChanged(0)
    controller.dismissForUnbind()
    controller.destroy()
    timer.advance(TTL * 2)
    assertEquals(size, events.size)
  }

  @Test
  fun `back on a focusable text prototype dismisses through the controller once as user`() =
    runTest {
      val field = PrototypeTextFieldNode(stateKey = "query")
      controller.show(
        null,
        spec().copy(root = field, state = mapOf("query" to PrototypeScalar.Text(""))),
      )
      fun back(action: Int) =
        manager.view!!.dispatchKeyEvent(KeyEvent(0L, 0L, action, KeyEvent.KEYCODE_BACK, 0))
      assertTrue(back(KeyEvent.ACTION_DOWN))
      assertTrue(host.isShowing)
      assertTrue(back(KeyEvent.ACTION_UP))
      assertFalse(host.isShowing)
      assertNull(controller.activeRuntime)
      assertSingleDismiss("user")
      assertEquals(1, detached)
      assertNoFurtherEvents()
    }

  @Test
  fun `relayout of a detached window re-shows the same runtime without an event`() = runTest {
    controller.show(null, spec())
    val runtime = checkNotNull(controller.activeRuntime)
    detachPlatformWindow()
    controller.onConfigurationChanged()
    assertTrue(host.isShowing)
    assertSame(runtime, controller.activeRuntime)
    assertEquals(2, manager.added.size)
    assertTrue(events.isEmpty())
    manager.failRemove = false
    controller.dismiss("agent", "panel", null)
    assertSingleDismiss("agent")
  }

  @Test
  fun `a gesture finding the window detached reports it so the controller can restore promptly`() =
    runTest {
      controller.show(null, spec())
      val runtime = checkNotNull(controller.activeRuntime)
      manager.failUpdate = true
      manager.updateFailure = IllegalArgumentException("View not attached to window manager")
      assertTrue(runCatching { host.withTouchThrough {} }.isFailure)
      assertEquals(1, lost)
      assertFalse(host.isShowing)
      // The service wires onWindowLost to this signal: the runtime comes back, not stays
      // windowless.
      manager.failUpdate = false
      controller.onConfigurationChanged()
      assertTrue(host.isShowing)
      assertSame(runtime, controller.activeRuntime)
      assertTrue(events.isEmpty())
    }

  @Test
  fun `relayout of a detached window that cannot return ends once as teardown`() = runTest {
    controller.show(null, spec())
    val runtime = checkNotNull(controller.activeRuntime)
    detachPlatformWindow()
    manager.failAdd = true
    controller.onConfigurationChanged()
    assertFalse(host.isShowing)
    assertNull(controller.activeRuntime)
    assertFalse(runtime.current.active)
    assertSingleDismiss("teardown")
    assertEquals(1, detached)
    assertNoFurtherEvents()
  }

  @Test
  fun `relayout failure on an attached window stays retryable and emits nothing`() = runTest {
    controller.show(null, spec())
    manager.failUpdate = true
    controller.onConfigurationChanged()
    assertTrue(host.isShowing)
    assertNotNull(controller.activeRuntime)
    assertTrue(events.isEmpty())
    manager.failUpdate = false
    controller.onConfigurationChanged()
    assertEquals(1, manager.updated.size)
    assertTrue(events.isEmpty())
  }

  @Test
  fun `agent dismiss of a detached window still emits its reason and restores highlights`() =
    runTest {
      controller.show(null, spec())
      detachPlatformWindow()
      controller.dismiss("agent", "panel", null)
      assertEquals(listOf(true to null, true to null), results)
      assertFalse(host.isShowing)
      assertSingleDismiss("agent")
      assertEquals(1, detached)
      assertNoFurtherEvents()
    }

  @Test
  fun `host dismiss row on a detached window emits user`() = runTest {
    controller.show(null, spec())
    detachPlatformWindow()
    controller.interact(checkNotNull(controller.activeRuntime), PrototypeInteraction.HostDismiss)
    assertFalse(host.isShowing)
    assertSingleDismiss("user")
    assertEquals(1, detached)
    assertNoFurtherEvents()
  }

  @Test
  fun `ttl on a detached window emits once`() = runTest {
    controller.show(null, spec())
    detachPlatformWindow()
    timer.advance(TTL)
    assertSingleDismiss("ttl")
    assertEquals(1, detached)
    assertNoFurtherEvents()
  }

  @Test
  fun `disconnect on a detached window emits once`() = runTest {
    controller.show(null, spec())
    detachPlatformWindow()
    controller.onClientCountChanged(0)
    assertSingleDismiss("disconnect")
    assertEquals(1, detached)
    assertNoFurtherEvents()
  }

  @Test
  fun `unbind of a detached window emits teardown once and destroy adds nothing`() = runTest {
    controller.show(null, spec())
    detachPlatformWindow()
    controller.dismissForUnbind()
    assertSingleDismiss("teardown")
    assertEquals(1, detached)
    controller.destroy() // service onDestroy after the unbind
    assertEquals(1, events.size)
  }

  @Test
  fun `unbind keeps the controller reusable so a rebind can show again`() = runTest {
    controller.show(null, spec())
    controller.dismissForUnbind()
    assertFalse(host.isShowing)
    assertSingleDismiss("teardown")
    controller.show("again", spec())
    assertTrue(host.isShowing)
    assertEquals(listOf(true to null, true to null), results)
  }

  @Test
  fun `keyguard hide of a detached window still hides then restores the same runtime`() = runTest {
    controller.show(null, spec())
    val runtime = checkNotNull(controller.activeRuntime)
    detachPlatformWindow()
    blocked = true
    controller.onConfigurationChanged()
    assertFalse(host.isShowing)
    assertSame(runtime, controller.activeRuntime)
    assertEquals(1, detached)
    assertTrue(events.isEmpty())
    blocked = false
    controller.onConfigurationChanged()
    assertTrue(host.isShowing)
    assertSame(runtime, controller.activeRuntime)
    assertTrue(events.isEmpty())
  }

  @Test
  fun `keyguard restore that cannot add the window ends once as teardown not stuck`() = runTest {
    controller.show(null, spec())
    blocked = true
    controller.onConfigurationChanged()
    assertFalse(host.isShowing)
    blocked = false
    manager.failAdd = true
    controller.onConfigurationChanged()
    assertNull(controller.activeRuntime)
    assertSingleDismiss("teardown")
    assertEquals(2, detached)
    assertNoFurtherEvents()
  }

  @Test
  fun `a lock arriving during restore keeps the runtime hidden instead of ending it`() = runTest {
    controller.show(null, spec())
    blocked = true
    controller.onConfigurationChanged()
    // Controller sees unlocked; the host's show then sees locked, as do later reads.
    blockedScript += listOf(false, true)
    controller.onConfigurationChanged()
    assertFalse(host.isShowing)
    assertNotNull(controller.activeRuntime)
    assertTrue(events.isEmpty())
  }

  @Test
  fun `a lock arriving during relayout hides the window and restores highlights`() = runTest {
    controller.show(null, spec())
    blockedScript +=
      listOf(false, true) // Controller sees unlocked; the host's relayout sees locked.
    controller.onConfigurationChanged()
    assertFalse(host.isShowing)
    assertNotNull(controller.activeRuntime)
    assertEquals(1, detached)
    assertTrue(events.isEmpty())
  }

  private companion object {
    const val TTL = 10L

    @JvmStatic
    @org.junit.BeforeClass
    fun warm() {
      runTest {}
      PrototypeSpecValidator.validate("{}")
    }
  }
}
