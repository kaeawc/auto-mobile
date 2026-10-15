package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.FoldPosture
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.Kind
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.PostureFlowSource
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.PostureSource
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.postureCode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.BeforeClass
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DeviceStateTransitionsRegistrationTest {
  companion object {
    @BeforeClass
    @JvmStatic
    fun warmScheduler() {
      runTest {} // Keep coroutine scheduler initialization outside per-test timing.
    }
  }

  private val flat = FoldPosture(Kind.FLAT, isSeparating = false)
  private val halfOpened = flat.copy(state = Kind.HALF_OPENED, isSeparating = true)

  private class FakeSource : PostureSource {
    var listener: ((List<FoldPosture>) -> Unit)? = null
    var closes = 0

    override fun observe(onPostures: (List<FoldPosture>) -> Unit): AutoCloseable {
      listener = onPostures
      return AutoCloseable { closes++ }
    }

    // Retain the listener to simulate an already queued delivery after close.
    fun emit(vararg postures: FoldPosture) {
      listener!!.invoke(postures.toList())
    }
  }

  private class Warnings {
    val entries = mutableListOf<Pair<String, Throwable?>>()

    fun warn(message: String, cause: Throwable?) {
      entries += message to cause
    }

    fun assertLost(cause: Throwable?) {
      assertEquals(1, entries.size)
      assertTrue(entries.single().first.contains("fold-posture events are lost"))
      assertSame(cause, entries.single().second)
    }
  }

  @Test
  fun `old window extensions warn but still observe`() {
    for (version in listOf(0, 1)) {
      val source = FakeSource()
      val warnings = Warnings()
      val states = mutableListOf<Int>()
      val registration =
        DeviceStateTransitions.register(source, 30, warnings::warn, { version }) { states += it }
      assertNotNull(registration)
      warnings.assertLost(null)
      assertEquals(
        "WindowManager window extensions level $version < 2 cannot report fold posture from a service context; fold-posture events are lost",
        warnings.entries.single().first,
      )
      source.emit(flat)
      source.emit(halfOpened)
      assertEquals(listOf(postureCode(listOf(halfOpened))), states)
      registration!!.close()
    }
  }

  @Test
  fun `supported window extensions observe silently`() {
    for (version in listOf(2, 3)) {
      val source = FakeSource()
      val warnings = Warnings()
      val registration =
        DeviceStateTransitions.register(source, 30, warnings::warn, { version }) { fail() }
      assertNotNull(source.listener)
      assertTrue(warnings.entries.isEmpty())
      registration!!.close()
    }
  }

  @Test
  fun `extension version failures warn but still observe`() {
    for (failure in listOf(IllegalStateException("backend"), NoClassDefFoundError("extensions"))) {
      val source = FakeSource()
      val warnings = Warnings()
      val registration =
        DeviceStateTransitions.register(source, 30, warnings::warn, { throw failure }) { fail() }
      assertNotNull(source.listener)
      assertEquals(1, warnings.entries.size)
      assertEquals(
        "WindowManager extension version unavailable; fold-posture events may be lost",
        warnings.entries.single().first,
      )
      assertSame(failure, warnings.entries.single().second)
      registration!!.close()
    }
  }

  @Test
  fun `listener failure warns and later emissions still arrive`() {
    val failure = IllegalStateException("listener failed")
    val warnings = Warnings()
    val test = TestScope()
    val delivered = mutableListOf<List<FoldPosture>>()
    val source =
      PostureFlowSource(
        {
          flow {
            emit(listOf(flat))
            emit(listOf(halfOpened))
            emit(emptyList())
          }
        },
        StandardTestDispatcher(test.testScheduler),
        warnings::warn,
      )
    val registration = source.observe {
      if (it == listOf(flat)) throw failure
      delivered += it
    }
    test.runCurrent()
    assertEquals(listOf(listOf(halfOpened), emptyList()), delivered)
    assertEquals(listOf("fold-posture listener failed" to failure), warnings.entries)
    registration.close()
  }

  @Test
  fun `listener cancellation propagates without warning and stops collection`() {
    val warnings = Warnings()
    val test = TestScope()
    var deliveries = 0
    var released = false
    val source =
      PostureFlowSource(
        {
          flow {
            try {
              emit(listOf(flat))
              emit(listOf(halfOpened))
            } finally {
              released = true
            }
          }
        },
        StandardTestDispatcher(test.testScheduler),
        warnings::warn,
      )
    val registration = source.observe {
      deliveries++
      throw CancellationException("listener cancelled")
    }
    test.runCurrent()
    assertEquals(1, deliveries)
    assertTrue(released)
    assertTrue(warnings.entries.isEmpty())
    registration.close()
  }

  @Test
  fun `baseline and unchanged re-emissions are suppressed`() {
    val source = FakeSource()
    val states = mutableListOf<Int>()
    val warnings = Warnings()
    val registration = DeviceStateTransitions.register(source, 30, warnings::warn) { states += it }
    assertNotNull(registration)
    source.emit(flat)
    source.emit(flat)
    assertTrue(states.isEmpty())
    source.emit(halfOpened)
    source.emit(halfOpened)
    assertEquals(listOf(postureCode(listOf(halfOpened))), states)
    assertTrue(warnings.entries.isEmpty())
    registration!!.close()
  }

  @Test
  fun `flat to half opened to absent emits opaque codes`() {
    val source = FakeSource()
    val states = mutableListOf<Int>()
    val registration =
      DeviceStateTransitions.register(source, 37, { _, _ -> fail() }) { states += it }
    source.emit(flat)
    source.emit(halfOpened)
    source.emit()
    source.emit()
    assertEquals(listOf(postureCode(listOf(halfOpened)), 0), states)
    registration!!.close()
  }

  @Test
  fun `close stops queued delivery and closes source once`() {
    val source = FakeSource()
    val states = mutableListOf<Int>()
    val registration =
      DeviceStateTransitions.register(source, 30, { _, _ -> fail() }) { states += it }
    source.emit(flat)
    registration!!.close()
    registration.close()
    source.emit(halfOpened)
    assertTrue(states.isEmpty())
    assertEquals(1, source.closes)
  }

  @Test
  fun `absent folding features are silent without warnings`() {
    val source = FakeSource()
    val warnings = Warnings()
    val registration = DeviceStateTransitions.register(source, 30, warnings::warn) { fail() }
    source.emit()
    source.emit()
    assertTrue(warnings.entries.isEmpty())
    registration!!.close()
  }

  @Test
  fun `source start failures return null and warn with the cause`() {
    for (failure in listOf(SecurityException("denied"), IllegalArgumentException("not UI"))) {
      val warnings = Warnings()
      val source = PostureSource { throw failure }
      assertNull(DeviceStateTransitions.register(source, 30, warnings::warn) { fail() })
      warnings.assertLost(failure)
    }
  }

  @Test
  fun `linkage failure returns null and warns with the cause`() {
    val failure = NoClassDefFoundError("window backend")
    val warnings = Warnings()
    assertNull(
      DeviceStateTransitions.register(PostureSource { throw failure }, 30, warnings::warn) {
        fail()
      },
    )
    warnings.assertLost(failure)
  }

  @Test
  fun `cancellation propagates without warning`() {
    val failure = CancellationException("closed")
    val warnings = Warnings()
    try {
      DeviceStateTransitions.register(PostureSource { throw failure }, 30, warnings::warn) {
        fail()
      }
      fail("cancellation must propagate")
    } catch (e: CancellationException) {
      assertSame(failure, e)
    }
    assertTrue(warnings.entries.isEmpty())
  }

  @Test
  fun `pre 30 returns null and warns without starting source`() {
    val warnings = Warnings()
    assertNull(
      DeviceStateTransitions.register(
        PostureSource { error("must not start") },
        29,
        warnings::warn,
      ) {
        fail()
      },
    )
    warnings.assertLost(null)
  }

  @Test
  fun `flow collection uses supplied dispatcher and close cancels upstream`() {
    val test = TestScope()
    val updates = MutableSharedFlow<List<FoldPosture>>(extraBufferCapacity = 1)
    val warnings = Warnings()
    val source =
      PostureFlowSource({ updates }, StandardTestDispatcher(test.testScheduler), warnings::warn)
    val states = mutableListOf<Int>()
    val registration = DeviceStateTransitions.register(source, 30, warnings::warn) { states += it }
    assertEquals(0, updates.subscriptionCount.value)
    test.runCurrent()
    assertEquals(1, updates.subscriptionCount.value)
    updates.tryEmit(listOf(flat))
    test.runCurrent()
    updates.tryEmit(listOf(halfOpened))
    // Delivery is queued until the injected dispatcher runs.
    assertTrue(states.isEmpty())
    test.runCurrent()
    assertEquals(listOf(postureCode(listOf(halfOpened))), states)
    registration!!.close()
    test.runCurrent()
    assertEquals(0, updates.subscriptionCount.value)
    assertTrue(warnings.entries.isEmpty())
  }

  @Test
  fun `flow provider startup failure returns null and warns`() {
    val failure = IllegalArgumentException("not a UI context")
    val warnings = Warnings()
    val test = TestScope()
    val source =
      PostureFlowSource(
        { throw failure },
        StandardTestDispatcher(test.testScheduler),
        warnings::warn,
      )
    assertNull(DeviceStateTransitions.register(source, 30, warnings::warn) { fail() })
    warnings.assertLost(failure)
  }

  @Test
  fun `collection cancellation does not warn`() {
    val warnings = Warnings()
    val test = TestScope()
    val source =
      PostureFlowSource(
        { flow { throw CancellationException("closed") } },
        StandardTestDispatcher(test.testScheduler),
        warnings::warn,
      )
    val registration = DeviceStateTransitions.register(source, 30, warnings::warn) { fail() }
    test.runCurrent()
    assertTrue(warnings.entries.isEmpty())
    registration!!.close()
  }

  @Test
  fun `asynchronous collection failure warns and releases collection`() {
    val failure = IllegalStateException("backend failed")
    val warnings = Warnings()
    val test = TestScope()
    var released = false
    val source =
      PostureFlowSource(
        {
          flow {
            try {
              throw failure
            } finally {
              released = true
            }
          }
        },
        StandardTestDispatcher(test.testScheduler),
        warnings::warn,
      )
    val registration = DeviceStateTransitions.register(source, 30, warnings::warn) { fail() }
    assertFalse(released)
    test.runCurrent()
    assertTrue(released)
    warnings.assertLost(failure)
    assertEquals(
      "WindowManager collection failed; fold-posture events are lost",
      warnings.entries.single().first,
    )
    test.runCurrent()
    assertEquals(1, warnings.entries.size)
    registration!!.close()
  }
}
