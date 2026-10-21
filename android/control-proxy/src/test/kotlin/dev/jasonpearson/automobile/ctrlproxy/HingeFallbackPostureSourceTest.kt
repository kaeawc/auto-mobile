package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.FoldPosture
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.Kind
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.PostureSource
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.postureCode
import java.util.concurrent.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class HingeFallbackPostureSourceTest {
  private val flat = FoldPosture(Kind.FLAT, isSeparating = false)
  private val halfOpened = FoldPosture(Kind.HALF_OPENED, isSeparating = true)

  private class FakeSource : PostureSource {
    var listener: ((List<FoldPosture>) -> Unit)? = null
    var initialPostures: List<FoldPosture>? = null
    var closes = 0
    var observeFailure: Throwable? = null
    var closeFailure: Throwable? = null

    override fun observe(onPostures: (List<FoldPosture>) -> Unit): AutoCloseable {
      listener = onPostures
      observeFailure?.let { throw it }
      initialPostures?.let(onPostures)
      return AutoCloseable {
        closes++
        closeFailure?.let { throw it }
      }
    }

    // Keep listeners so tests can simulate queued deliveries after close.
    fun emit(vararg postures: FoldPosture) {
      listener!!.invoke(postures.toList())
    }
  }

  private class FakeHingeSource : HingeAngleSource {
    var listener: ((Float) -> Unit)? = null
    var closes = 0
    var observeFailure: Throwable? = null
    var closeFailure: Throwable? = null

    override fun observe(onAngle: (Float) -> Unit): AutoCloseable {
      listener = onAngle
      observeFailure?.let { throw it }
      return AutoCloseable {
        closes++
        closeFailure?.let { throw it }
      }
    }

    fun emit(angle: Float) {
      listener!!.invoke(angle)
    }
  }

  private class Fixture {
    val primary = FakeSource()
    val hinge = FakeHingeSource()
    val infos = mutableListOf<String>()
    val warnings = mutableListOf<Pair<String, Throwable?>>()
    val delivered = mutableListOf<List<FoldPosture>>()

    fun warn(message: String, cause: Throwable?) {
      warnings += message to cause
    }

    fun source(hingeSource: HingeAngleSource = hinge): HingeFallbackPostureSource =
      HingeFallbackPostureSource(primary, hingeSource, { infos += it }, ::warn)

    fun observe(hingeSource: HingeAngleSource = hinge): AutoCloseable =
      source(hingeSource).observe { delivered += it }
  }

  @Test
  fun `silent tracker uses hinge for flat half opened closed and flat`() {
    val fixture = Fixture()
    val registration = fixture.observe()
    fixture.hinge.emit(180f)
    fixture.hinge.emit(90f)
    fixture.hinge.emit(0f)
    fixture.hinge.emit(180f)
    assertEquals(
      listOf(listOf(flat), listOf(halfOpened), emptyList(), listOf(flat)),
      fixture.delivered,
    )
    assertTrue(fixture.warnings.isEmpty())
    registration.close()
  }

  @Test
  fun `registration uses first hinge posture as baseline then reports distinct transitions`() {
    val fixture = Fixture()
    val states = mutableListOf<Int>()
    val registration =
      DeviceStateTransitions.register(
        source = fixture.source(),
        sdkInt = 36,
        warn = fixture::warn,
        extensionVersion = { 2 },
        onState = { states += it },
      )
    assertNotNull(registration)
    fixture.primary.emit()
    fixture.hinge.emit(180f)
    assertTrue(states.isEmpty())
    fixture.hinge.emit(90f)
    fixture.hinge.emit(0f)
    fixture.hinge.emit(180f)
    fixture.hinge.emit(180f)
    assertEquals(
      listOf(postureCode(listOf(halfOpened)), postureCode(emptyList()), postureCode(listOf(flat))),
      states,
    )
    assertTrue(fixture.warnings.isEmpty())
    registration!!.close()
  }

  @Test
  fun `primary empty layouts are dropped until a folding feature activates primary`() {
    val fixture = Fixture()
    val registration = fixture.observe()
    fixture.primary.emit()
    fixture.primary.emit()
    assertTrue(fixture.delivered.isEmpty())
    fixture.primary.emit(flat)
    fixture.hinge.emit(90f)
    fixture.hinge.emit(0f)
    fixture.primary.emit()
    fixture.hinge.emit(180f)
    assertEquals(listOf(listOf(flat), emptyList()), fixture.delivered)
    registration.close()
  }

  @Test
  fun `primary takes over after hinge has delivered`() {
    val fixture = Fixture()
    val registration = fixture.observe()
    fixture.primary.emit()
    fixture.hinge.emit(180f)
    fixture.primary.emit(halfOpened)
    fixture.hinge.emit(180f)
    fixture.primary.emit()
    fixture.hinge.emit(90f)
    assertEquals(listOf(listOf(flat), listOf(halfOpened), emptyList()), fixture.delivered)
    registration.close()
  }

  @Test
  fun `primary registration failures warn and hinge still delivers`() {
    for (failure in listOf(IllegalStateException("primary"), NoClassDefFoundError("primary"))) {
      val fixture = Fixture()
      fixture.primary.observeFailure = failure
      val registration = fixture.observe()
      fixture.hinge.emit(180f)
      assertEquals(listOf(listOf(flat)), fixture.delivered)
      assertEquals(
        listOf("fold-posture primary source failed; relying on hinge-angle fallback" to failure),
        fixture.warnings,
      )
      registration.close()
      assertEquals(1, fixture.hinge.closes)
    }
  }

  @Test
  fun `hinge registration failures warn and primary still delivers`() {
    for (failure in listOf(IllegalStateException("hinge"), NoClassDefFoundError("hinge"))) {
      val fixture = Fixture()
      fixture.primary.initialPostures = emptyList()
      fixture.hinge.observeFailure = failure
      val registration = fixture.observe()
      assertEquals(listOf(emptyList<FoldPosture>()), fixture.delivered)
      fixture.primary.emit()
      fixture.primary.emit(flat)
      fixture.primary.emit()
      fixture.primary.emit(halfOpened)
      assertEquals(
        listOf(emptyList(), emptyList(), listOf(flat), emptyList(), listOf(halfOpened)),
        fixture.delivered,
      )
      assertEquals(
        listOf("fold-posture hinge-angle source failed; relying on WindowManager only" to failure),
        fixture.warnings,
      )
      registration.close()
      assertEquals(1, fixture.primary.closes)
    }
  }

  @Test
  fun `missing hinge sensor logs once and primary still works`() {
    val fixture = Fixture()
    val registration = fixture.observe(HingeAngleSource { null })
    fixture.primary.emit()
    fixture.primary.emit(flat)
    fixture.primary.emit()
    fixture.primary.emit(halfOpened)
    assertEquals(
      listOf(emptyList(), listOf(flat), emptyList(), listOf(halfOpened)),
      fixture.delivered,
    )
    assertEquals(
      1,
      fixture.infos.count {
        it == "no hinge-angle sensor; fold posture depends on WindowManager only"
      },
    )
    assertTrue(fixture.warnings.isEmpty())
    registration.close()
    assertEquals(1, fixture.primary.closes)
  }

  @Test
  fun `missing hinge replays empty layout received during primary registration`() {
    val fixture = Fixture()
    fixture.primary.initialPostures = emptyList()
    val registration = fixture.observe(HingeAngleSource { null })
    assertEquals(listOf(emptyList<FoldPosture>()), fixture.delivered)
    fixture.primary.emit()
    fixture.primary.emit(flat)
    assertEquals(listOf(emptyList(), emptyList(), listOf(flat)), fixture.delivered)
    assertTrue(fixture.warnings.isEmpty())
    registration.close()
  }

  @Test
  fun `missing hinge does not replay pending empty once primary is active`() {
    val fixture = Fixture()
    fixture.primary.initialPostures = emptyList()
    val registration =
      fixture.observe(
        HingeAngleSource {
          fixture.primary.emit(flat)
          null
        },
      )
    assertEquals(listOf(listOf(flat)), fixture.delivered)
    fixture.primary.emit()
    assertEquals(listOf(listOf(flat), emptyList()), fixture.delivered)
    registration.close()
  }

  @Test
  fun `hinge listener failures warn without propagating or stopping deliveries`() {
    val fixture = Fixture()
    val failure = IllegalStateException("listener")
    val registration =
      fixture.source().observe {
        fixture.delivered += it
        if (it == listOf(flat)) throw failure
      }
    fixture.hinge.emit(180f)
    fixture.hinge.emit(90f)
    assertEquals(listOf(listOf(flat), listOf(halfOpened)), fixture.delivered)
    assertEquals(listOf("fold-posture hinge-angle listener failed" to failure), fixture.warnings)
    registration.close()
  }

  @Test
  fun `hinge listener cancellation propagates without warning`() {
    val fixture = Fixture()
    val cancellation = CancellationException("listener cancelled")
    val registration = fixture.source().observe { throw cancellation }
    try {
      fixture.hinge.emit(180f)
      fail("Expected cancellation")
    } catch (actual: CancellationException) {
      assertSame(cancellation, actual)
    }
    assertTrue(fixture.warnings.isEmpty())
    registration.close()
  }

  @Test
  fun `close releases both once and drops queued deliveries`() {
    val fixture = Fixture()
    val registration = fixture.observe()
    fixture.hinge.emit(180f)
    val infosBeforeClose = fixture.infos.toList()
    registration.close()
    registration.close()
    fixture.primary.emit(flat)
    fixture.primary.emit()
    fixture.hinge.emit(90f)
    assertEquals(1, fixture.primary.closes)
    assertEquals(1, fixture.hinge.closes)
    assertEquals(listOf(listOf(flat)), fixture.delivered)
    assertEquals(infosBeforeClose, fixture.infos)
    assertTrue(fixture.warnings.isEmpty())
  }

  @Test
  fun `close failures warn without skipping either registration`() {
    for (failure in listOf(IllegalStateException("close"), NoClassDefFoundError("close"))) {
      for (primaryFails in listOf(true, false)) {
        val fixture = Fixture()
        if (primaryFails) fixture.primary.closeFailure = failure
        else fixture.hinge.closeFailure = failure
        val registration = fixture.observe()
        registration.close()
        registration.close()
        fixture.primary.emit(flat)
        fixture.hinge.emit(90f)
        assertEquals(1, fixture.primary.closes)
        assertEquals(1, fixture.hinge.closes)
        assertTrue(fixture.delivered.isEmpty())
        val name = if (primaryFails) "primary" else "hinge-angle"
        assertEquals(listOf("fold-posture $name source close failed" to failure), fixture.warnings)
      }
    }
  }

  @Test
  fun `diagnostics log each milestone once despite repeated readings`() {
    val fixture = Fixture()
    val registration = fixture.observe()
    repeat(2) { fixture.primary.emit() }
    fixture.hinge.emit(Float.NaN)
    fixture.hinge.emit(-1f)
    repeat(2) { fixture.hinge.emit(180f) }
    fixture.hinge.emit(90f)
    repeat(2) { fixture.primary.emit(flat) }
    fixture.primary.emit()
    fixture.hinge.emit(0f)
    assertEquals(
      listOf(
        "WindowManager first layout: 0 folding feature(s)",
        "WindowManager reported no folding feature (initial layout); hinge-angle fallback stays armed",
        "WindowManager silent; using hinge-angle fallback (angle=180.0)",
        "WindowManager reported a folding feature; hinge-angle fallback disabled",
      ),
      fixture.infos,
    )
    assertEquals(
      listOf(
        listOf(flat),
        listOf(flat),
        listOf(halfOpened),
        listOf(flat),
        listOf(flat),
        emptyList(),
      ),
      fixture.delivered,
    )
    registration.close()
  }

  @Test
  fun `first nonempty primary layout logs its feature count once`() {
    val fixture = Fixture()
    val registration = fixture.observe()
    fixture.primary.emit(flat, halfOpened)
    fixture.primary.emit(flat)
    fixture.primary.emit()
    assertEquals(
      listOf(
        "WindowManager first layout: 2 folding feature(s)",
        "WindowManager reported a folding feature; hinge-angle fallback disabled",
      ),
      fixture.infos,
    )
    registration.close()
  }

  @Test
  fun `registration cancellation propagates without warning and releases primary`() {
    for (primaryCancels in listOf(true, false)) {
      val fixture = Fixture()
      val cancellation = CancellationException("cancelled")
      if (primaryCancels) fixture.primary.observeFailure = cancellation
      else fixture.hinge.observeFailure = cancellation
      try {
        fixture.observe()
        fail("Expected cancellation")
      } catch (actual: CancellationException) {
        assertSame(cancellation, actual)
      }
      assertTrue(fixture.warnings.isEmpty())
      assertEquals(if (primaryCancels) 0 else 1, fixture.primary.closes)
      fixture.primary.emit(flat)
      if (!primaryCancels) fixture.hinge.emit(90f)
      assertTrue(fixture.delivered.isEmpty())
    }
  }

  @Test
  fun `close cancellation propagates but still releases other registration`() {
    val fixture = Fixture()
    val cancellation = CancellationException("cancelled close")
    fixture.primary.closeFailure = cancellation
    val registration = fixture.observe()
    try {
      registration.close()
      fail("Expected cancellation")
    } catch (actual: CancellationException) {
      assertSame(cancellation, actual)
    }
    registration.close()
    assertEquals(1, fixture.primary.closes)
    assertEquals(1, fixture.hinge.closes)
    assertTrue(fixture.warnings.isEmpty())
  }
}
