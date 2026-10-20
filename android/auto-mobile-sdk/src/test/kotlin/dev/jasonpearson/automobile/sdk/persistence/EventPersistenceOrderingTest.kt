package dev.jasonpearson.automobile.sdk.persistence

import dev.jasonpearson.automobile.sdk.events.DefaultDropCounter
import dev.jasonpearson.automobile.sdk.events.DropReason
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class EventPersistenceOrderingTest : EventPersistenceFixture() {
  @Test
  fun `clock regression preserves arrival order and newest batch at cap one`() {
    var now = 2000L
    val counter = DefaultDropCounter()
    val persistence =
      FileEventPersistence(
        tempFolder.root,
        clock = { now },
        maxPendingBatches = 1,
        dropCounter = counter,
      )
    persistence.persist(List(3) { makeLifecycleEvent("old") })
    now = 1000L
    val newest = persistence.persist(listOf(makeLifecycleEvent("new")))
    assertNotNull(newest)
    assertEquals(listOf(newest), persistence.loadPending().map { it.storageId })
    assertEquals(3L, counter.snapshot()[DropReason.BUFFER_OVERFLOW])
  }

  @Test
  fun `clock regression preserves arrival order with room for both batches`() {
    var now = 2000L
    val persistence = FileEventPersistence(tempFolder.root, clock = { now })
    val first = persistence.persist(listOf(makeLifecycleEvent("first")))
    now = 1000L
    val second = persistence.persist(listOf(makeLifecycleEvent("second")))
    assertEquals(listOf(first, second), persistence.loadPending().map { it.storageId })
  }

  @Test
  fun `equal timestamps ignore opposite UUID order including underscores`() {
    var uuid = "z_uuid-with-dash"
    val persistence =
      FileEventPersistence(tempFolder.root, clock = { 1000L }, uuidProvider = { uuid })
    val first = persistence.persist(listOf(makeLifecycleEvent("first")))
    uuid = "a_uuid-with-dash"
    val second = persistence.persist(listOf(makeLifecycleEvent("second")))
    assertEquals(listOf(first, second), persistence.loadPending().map { it.storageId })
  }

  @Test
  fun `sequence recovered across instances and lazily before first write`() {
    val oldInstance = createPersistence(clock = { 2000L })
    val newInstance = createPersistence(clock = { 1000L })
    val first = oldInstance.persist(listOf(makeLifecycleEvent("first")))
    val second = oldInstance.persist(listOf(makeLifecycleEvent("second")))
    val third = newInstance.persist(listOf(makeLifecycleEvent("third")))
    assertTrue(third!!.startsWith("s00000000000000000003_"))
    assertEquals(listOf(first, second, third), newInstance.loadPending().map { it.storageId })
  }

  @Test
  fun `sequence initialized on first read survives removal of highest existing file`() {
    val persistence = createPersistence()
    persistence.persist(listOf(makeLifecycleEvent("first")))
    val highest = persistence.persist(listOf(makeLifecycleEvent("second")))!!
    val reloaded = createPersistence()
    reloaded.loadPending()
    reloaded.removeBatch(highest)
    val newest = reloaded.persist(listOf(makeLifecycleEvent("third")))!!
    assertTrue(newest.startsWith("s00000000000000000003_"))
  }

  @Test
  fun `legacy files sort first numerically then by name and remain removable`() {
    val persistence = createPersistence(clock = { 1L })
    val newest = persistence.persist(listOf(makeLifecycleEvent("new")))
    writeLegacy("20_z_uuid", listOf(makeLifecycleEvent("z")))
    writeLegacy("20_a_uuid", listOf(makeLifecycleEvent("a")))
    writeLegacy("9_b_uuid", listOf(makeLifecycleEvent("b")))
    assertEquals(
      listOf("9_b_uuid", "20_a_uuid", "20_z_uuid", newest),
      persistence.loadPending().map { it.storageId },
    )
    persistence.removeBatch("20_a_uuid")
    assertEquals(
      listOf("9_b_uuid", "20_z_uuid", newest),
      persistence.loadPending().map { it.storageId },
    )
  }
}
