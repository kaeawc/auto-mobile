package dev.jasonpearson.automobile.sdk.noop

import dev.jasonpearson.automobile.protocol.SdkLogEvent
import dev.jasonpearson.automobile.sdk.NavigationEvent
import dev.jasonpearson.automobile.sdk.NavigationSource
import dev.jasonpearson.automobile.sdk.events.DropReason
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import org.junit.Test

class NoOpImplementationsTest {

  // -- NoOpDropCounter --

  @Test
  fun `NoOpDropCounter increment does not throw`() {
    NoOpDropCounter.increment(DropReason.DISABLED)
    NoOpDropCounter.increment(DropReason.SHUTDOWN, 10)
  }

  @Test
  fun `NoOpDropCounter snapshot returns empty map`() {
    NoOpDropCounter.increment(DropReason.DISABLED)
    assertTrue(NoOpDropCounter.snapshot().isEmpty())
  }

  @Test
  fun `NoOpDropCounter reset does not throw`() {
    NoOpDropCounter.reset()
  }

  // -- NoOpEventPersistence --

  @Test
  fun `NoOpEventPersistence persist returns null`() {
    val event = SdkLogEvent(timestamp = 1L, level = 4, tag = "test", message = "msg")
    assertNull(NoOpEventPersistence.persist(listOf(event)))
  }

  @Test
  fun `NoOpEventPersistence persist empty list returns null`() {
    assertNull(NoOpEventPersistence.persist(emptyList()))
  }

  @Test
  fun `NoOpEventPersistence loadPending returns empty list`() {
    assertTrue(NoOpEventPersistence.loadPending().isEmpty())
  }

  @Test
  fun `NoOpEventPersistence removeBatch does not throw`() {
    NoOpEventPersistence.removeBatch("any-batch-id")
  }

  @Test
  fun `NoOpEventPersistence cleanup does not throw`() {
    NoOpEventPersistence.cleanup()
    NoOpEventPersistence.cleanup(maxAgeDays = 30)
  }

  // -- NoOpEventProcessor --

  @Test
  fun `NoOpEventProcessor returns event unchanged`() {
    val event = SdkLogEvent(timestamp = 42L, level = 4, tag = "hello", message = "world")
    val result = NoOpEventProcessor.process(event)
    assertSame(event, result)
  }

  // -- NoOpNavigationListener --

  @Test
  fun `NoOpNavigationListener onNavigationEvent does not throw`() {
    val event =
        NavigationEvent(
            destination = "/home",
            source = NavigationSource.CUSTOM,
        )
    NoOpNavigationListener.onNavigationEvent(event)
  }
}
