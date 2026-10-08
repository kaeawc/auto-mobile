package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RotationProvenanceTrackerTest {

  interface TestStateCallback {
    fun onStateChanged(state: Int)
  }

  @Test
  fun `device state proxy has identity semantics and ignores the initial state`() {
    val states = mutableListOf<Int>()
    val callback =
      DeviceStateTransitions.callback(TestStateCallback::class.java) { states += it }
        as TestStateCallback
    assertTrue(callback == callback)
    assertFalse(callback == Any())
    assertEquals(System.identityHashCode(callback), callback.hashCode())
    assertTrue(callback.toString().startsWith("DeviceStateCallback@"))

    callback.onStateChanged(0)
    callback.onStateChanged(0)
    assertTrue(states.isEmpty())
    callback.onStateChanged(1)
    assertEquals(listOf(1), states)
  }

  @Test
  fun `unchanged phone state leaves its first capture proven`() {
    val changes = FakeRotationChangeSignal()
    val provenance = RotationProvenanceTracker(changes)
    val frames = mutableListOf<Int>()
    val observer = DeviceStateTransitions.StateObserver {
      frames += it
      changes.emitRotationChanged(0)
    }
    val capture = provenance.beginCapture()
    observer.accept(0)
    observer.accept(0)
    assertTrue(frames.isEmpty())
    assertEquals(0, provenance.rotationIfUnchanged(capture, 0, 0))
  }

  @Test
  fun `identical display callbacks are ignored and a size burst emits once`() {
    val frames = mutableListOf<DisplayTransition>()
    val scheduled = mutableListOf<Runnable>()
    var width = 1080
    val signal =
      DisplayRotationChangeSignal(
        null,
        onTransition = { frames += it },
        snapshotOverride = { id, change ->
          DisplayTransition(change, id, "panel", width, 2400, 2, rotation = 0)
        },
        scheduleTransition = { action, delay ->
          assertEquals(100L, delay)
          scheduled += action
        },
      )
    signal.handleDisplayCallback("added", 0)
    scheduled.removeAt(0).run()
    frames.clear()
    repeat(3) { signal.handleDisplayCallback("changed", 0) }
    assertTrue(frames.isEmpty())
    assertTrue(scheduled.isEmpty())
    width = 1200
    signal.handleDisplayCallback("changed", 0)
    width = 1300
    signal.handleDisplayCallback("changed", 0)
    assertEquals(1, scheduled.size)
    scheduled.removeAt(0).run()
    assertEquals(1, frames.size)
    assertEquals(1300, frames.single().width)
    assertEquals(0, frames.single().rotation)
  }

  @Test
  fun `non-default display callbacks emit typed transition frames`() {
    val frames = mutableListOf<String>()
    var width = 1080
    val signal =
      DisplayRotationChangeSignal(
        null,
        onTransition = { frames += displayTransitionFrame(it) },
        snapshotOverride = { displayId, change ->
          DisplayTransition(change, displayId, "panel-rear", width, 2520, 2)
        },
      )
    signal.handleDisplayCallback("added", 4)
    width = 1200
    signal.handleDisplayCallback("changed", 4)
    signal.handleDisplayCallback("removed", 4)

    assertEquals(3, frames.size)
    assertTrue(frames[0].contains("\"change\":\"added\""))
    assertTrue(frames[1].contains("\"change\":\"changed\""))
    assertTrue(frames[2].contains("\"change\":\"removed\""))
    frames.forEach { frame ->
      assertTrue(frame.contains("\"type\":\"display_transition\""))
      assertTrue(frame.contains("\"displayId\":4"))
      assertTrue(frame.contains("\"panelUniqueId\":\"panel-rear\""))
    }
  }

  @Test
  fun `queued A to B to A display changes make the capture rotation unproven`() {
    val changes = FakeRotationChangeSignal()
    val provenance = RotationProvenanceTracker(changes)

    val capture = provenance.beginCapture()
    changes.emitRotationChanged(1)
    changes.emitRotationChanged(0)

    assertEquals(2, changes.pendingChangeCount)
    assertNull(
      provenance.rotationIfUnchanged(
        capture,
        rotationAtCaptureStart = 0,
        rotationAtCaptureEnd = changes.rotation,
      ),
    )
    assertEquals(0, changes.pendingChangeCount)
  }

  @Test
  fun `a capture without a display change keeps its rotation`() {
    val provenance = RotationProvenanceTracker(FakeRotationChangeSignal())

    val capture = provenance.beginCapture()

    assertEquals(
      1,
      provenance.rotationIfUnchanged(
        capture,
        rotationAtCaptureStart = 1,
        rotationAtCaptureEnd = 1,
      ),
    )
  }

  @Test
  fun `a secondary display change does not invalidate the default display capture`() {
    val changes = FakeRotationChangeSignal()
    val provenance = RotationProvenanceTracker(changes)
    val defaultCapture = provenance.beginCapture(0)
    val secondaryCapture = provenance.beginCapture(4)

    changes.emitRotationChanged(1, displayId = 4)

    assertEquals(0, provenance.rotationIfUnchanged(defaultCapture, 0, 0, displayId = 0))
    assertNull(provenance.rotationIfUnchanged(secondaryCapture, 0, 0, displayId = 4))
  }

  @Test
  fun `a changed rotation is unproven before its callback is delivered`() {
    val provenance = RotationProvenanceTracker(FakeRotationChangeSignal())

    val capture = provenance.beginCapture()

    assertNull(
      provenance.rotationIfUnchanged(
        capture,
        rotationAtCaptureStart = 0,
        rotationAtCaptureEnd = 1,
      ),
    )
  }

  @Test
  fun `a capture is unproven when its callback queue cannot be drained`() {
    val provenance = RotationProvenanceTracker(FakeRotationChangeSignal(synchronizeResult = false))

    val capture = provenance.beginCapture()

    assertNull(
      provenance.rotationIfUnchanged(
        capture,
        rotationAtCaptureStart = 0,
        rotationAtCaptureEnd = 0,
      ),
    )
  }

  @Test
  fun `closing unregisters the display change callback`() {
    val changes = FakeRotationChangeSignal()
    val provenance = RotationProvenanceTracker(changes)

    assertTrue(changes.isRegistered)

    provenance.close()

    assertFalse(changes.isRegistered)
  }

  @Test
  fun `all capture routes use rotation provenance instead of endpoint equality`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(locateCtrlProxySource().readText())

    for (route in
      listOf(
        "private fun extractHierarchyDirect",
        "private fun extractHierarchy(",
        "private suspend fun takeScreenshotAsync",
      )) {
      val start = source.indexOf(route)
      assertTrue("$route not found in CtrlProxy.kt", start >= 0)
      val bodyOpen = source.indexOf('{', start)
      val body = source.substring(bodyOpen, KotlinSourceScan.matchBrace(source, bodyOpen))
      assertTrue(
        "$route must capture the display-change generation before acquiring capture inputs",
        "rotationProvenance.beginCapture(targetDisplayId)" in body,
      )
      assertTrue(
        "$route must retain rotation only when the display-change generation is stable",
        "rotationProvenance.rotationIfUnchanged(" in body,
      )
      assertTrue(
        "$route must retain the previous endpoint rotation guard until display callbacks arrive",
        "rotationAtCaptureStart" in body,
      )
      assertFalse(
        "$route must not rely on endpoint rotation equality, which misses A -> B -> A",
        "rotationBefore" in body,
      )
    }
  }

  @Test
  fun `screenshot capture passes the requested display to the platform`() {
    val source = KotlinSourceScan.maskLiteralsAndComments(locateCtrlProxySource().readText())
    val start = source.indexOf("private suspend fun takeScreenshotAsync")
    assertTrue(start >= 0)
    val bodyOpen = source.indexOf('{', start)
    val body = source.substring(bodyOpen, KotlinSourceScan.matchBrace(source, bodyOpen))
    assertTrue(body.contains("takeScreenshot(\n              targetDisplayId,"))
    assertFalse(body.contains("takeScreenshot(\n              Display.DEFAULT_DISPLAY,"))
  }

  private class FakeRotationChangeSignal(private val synchronizeResult: Boolean = true) :
    RotationChangeSignal {
    private var listener: ((Int) -> Unit)? = null
    private val pendingListeners = mutableListOf<() -> Unit>()
    var rotation: Int = 0
      private set

    val isRegistered: Boolean
      get() = listener != null

    val pendingChangeCount: Int
      get() = pendingListeners.size

    override fun register(listener: (Int) -> Unit): Boolean {
      this.listener = listener
      return true
    }

    override fun synchronize(): Boolean {
      if (!synchronizeResult) return false
      val queuedListeners = pendingListeners.toList()
      pendingListeners.clear()
      queuedListeners.forEach { it.invoke() }
      return true
    }

    override fun unregister() {
      listener = null
      pendingListeners.clear()
    }

    fun emitRotationChanged(rotation: Int, displayId: Int = 0) {
      this.rotation = rotation
      pendingListeners += { requireNotNull(listener)(displayId) }
    }
  }

  private fun locateCtrlProxySource(): File {
    val rel = "src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/CtrlProxy.kt"
    val direct =
      listOf(File(rel), File("control-proxy/$rel"), File("android/control-proxy/$rel"))
        .firstOrNull { it.isFile }
    if (direct != null) return direct

    var directory: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (directory != null) {
      for (candidate in
        listOf(
          File(directory, rel),
          File(directory, "control-proxy/$rel"),
          File(directory, "android/control-proxy/$rel"),
        )) {
        if (candidate.isFile) return candidate
      }
      directory = directory.parentFile
    }
    fail("Could not locate CtrlProxy.kt from user.dir=${System.getProperty("user.dir")}")
    error("unreachable")
  }
}
