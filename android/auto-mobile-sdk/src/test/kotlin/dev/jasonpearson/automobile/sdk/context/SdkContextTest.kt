package dev.jasonpearson.automobile.sdk.context

import java.util.concurrent.CountDownLatch
import java.util.concurrent.CyclicBarrier
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class SdkContextTest {

  private lateinit var context: SdkContext

  @Before
  fun setup() {
    context = SdkContext()
  }

  @Test
  fun `new context has null fields and empty tags`() {
    val snap = context.snapshot()
    assertNull(snap.sessionId)
    assertNull(snap.userId)
    assertNull(snap.appVersion)
    assertTrue(snap.tags.isEmpty())
  }

  @Test
  fun `set and get volatile fields`() {
    context.sessionId = "sess-1"
    context.userId = "user-42"
    context.tenantId = "tenant-42"
    context.currentScreen = "Home"
    context.appVersion = "1.2.3"

    val snap = context.snapshot()
    assertEquals("sess-1", snap.sessionId)
    assertEquals("user-42", snap.userId)
    assertEquals("tenant-42", snap.tenantId)
    assertEquals("Home", snap.currentScreen)
    assertEquals("1.2.3", snap.appVersion)
  }

  @Test
  fun `setTag adds a tag visible in snapshot`() {
    context.setTag("env", "production")
    assertEquals("production", context.snapshot().tags["env"])
  }

  @Test
  fun `removeTag removes an existing tag`() {
    context.setTag("env", "production")
    context.removeTag("env")
    assertNull(context.snapshot().tags["env"])
  }

  @Test
  fun `removeTag on missing key does not throw`() {
    context.removeTag("nonexistent")
    assertTrue(context.snapshot().tags.isEmpty())
  }

  @Test
  fun `clearTags removes all tags`() {
    context.setTag("a", "1")
    context.setTag("b", "2")
    context.clearTags()
    assertTrue(context.snapshot().tags.isEmpty())
  }

  @Test
  fun `snapshot returns immutable copy`() {
    context.setTag("key", "before")
    val snap = context.snapshot()

    // Mutate the original context after taking a snapshot
    context.setTag("key", "after")
    context.setTag("new", "value")

    // The snapshot should not reflect the mutations
    assertEquals("before", snap.tags["key"])
    assertNull(snap.tags["new"])
  }

  @Test
  fun `reset clears all fields and tags`() {
    context.sessionId = "sess-1"
    context.userId = "user-42"
    context.tenantId = "tenant-42"
    context.currentScreen = "Home"
    context.appVersion = "1.0.0"
    context.setTag("env", "prod")

    context.reset()

    val snap = context.snapshot()
    assertNull(snap.sessionId)
    assertNull(snap.userId)
    assertNull(snap.tenantId)
    assertNull(snap.currentScreen)
    assertNull(snap.appVersion)
    assertTrue(snap.tags.isEmpty())
  }

  @Test
  fun `snapshot includes tenant and current screen`() {
    val context = SdkContext()
    context.tenantId = "tenant-1"
    context.currentScreen = "Home"

    val snapshot = context.snapshot()

    assertEquals("tenant-1", snapshot.tenantId)
    assertEquals("Home", snapshot.currentScreen)
  }

  @Test
  fun `SdkContextSnapshot equality works as data class`() {
    val a = SdkContextSnapshot("s", "u", "1.0", mapOf("k" to "v"))
    val b = SdkContextSnapshot("s", "u", "1.0", mapOf("k" to "v"))
    assertEquals(a, b)
    assertEquals(a.hashCode(), b.hashCode())
  }

  @Test
  fun `SdkContextSnapshot inequality`() {
    val a = SdkContextSnapshot("s1", "u", "1.0", emptyMap())
    val b = SdkContextSnapshot("s2", "u", "1.0", emptyMap())
    assertNotEquals(a, b)
  }

  @Test
  fun `concurrent tag mutations do not throw`() {
    val threads = 8
    val iterations = 200
    val barrier = CyclicBarrier(threads)
    val latch = CountDownLatch(threads)
    val errors = mutableListOf<Throwable>()

    repeat(threads) { t ->
      Thread {
        try {
          barrier.await()
          repeat(iterations) { i ->
            context.setTag("t$t-$i", "v")
            context.snapshot()
            context.removeTag("t$t-$i")
          }
        } catch (e: Throwable) {
          synchronized(errors) { errors.add(e) }
        } finally {
          latch.countDown()
        }
      }
        .start()
    }

    latch.await()
    assertTrue("Concurrent mutations threw: $errors", errors.isEmpty())
  }
}
