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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DeviceStateTransitionsRegistrationTest {
  private val flat = FoldPosture(Kind.FLAT, isVertical = true, isSeparating = false)
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
    val registration = DeviceStateTransitions.register(source, 37, { _, _ -> fail() }) { states += it }
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
    val registration = DeviceStateTransitions.register(source, 30, { _, _ -> fail() }) { states += it }
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
      DeviceStateTransitions.register(PostureSource { throw failure }, 30, warnings::warn) { fail() },
    )
    warnings.assertLost(failure)
  }

  @Test
  fun `cancellation propagates without warning`() {
    val failure = CancellationException("closed")
    val warnings = Warnings()
    try {
      DeviceStateTransitions.register(PostureSource { throw failure }, 30, warnings::warn) { fail() }
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
      DeviceStateTransitions.register(PostureSource { error("must not start") }, 29, warnings::warn) {
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
      PostureFlowSource({ throw failure }, StandardTestDispatcher(test.testScheduler), warnings::warn)
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
    registration!!.close()
  }
}
