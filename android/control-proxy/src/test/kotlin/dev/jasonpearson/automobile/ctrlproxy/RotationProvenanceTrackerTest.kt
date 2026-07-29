package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RotationProvenanceTrackerTest {

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
      )
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
  fun `a changed rotation is unproven before its callback is delivered`() {
    val provenance = RotationProvenanceTracker(FakeRotationChangeSignal())

    val capture = provenance.beginCapture()

    assertNull(
      provenance.rotationIfUnchanged(
        capture,
        rotationAtCaptureStart = 0,
        rotationAtCaptureEnd = 1,
      )
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
      )
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
        "rotationProvenance.beginCapture()" in body,
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

  private class FakeRotationChangeSignal(private val synchronizeResult: Boolean = true) :
    RotationChangeSignal {
    private var listener: (() -> Unit)? = null
    private val pendingListeners = mutableListOf<() -> Unit>()
    var rotation: Int = 0
      private set

    val isRegistered: Boolean
      get() = listener != null

    val pendingChangeCount: Int
      get() = pendingListeners.size

    override fun register(listener: () -> Unit): Boolean {
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

    fun emitRotationChanged(rotation: Int) {
      this.rotation = rotation
      pendingListeners += requireNotNull(listener)
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
