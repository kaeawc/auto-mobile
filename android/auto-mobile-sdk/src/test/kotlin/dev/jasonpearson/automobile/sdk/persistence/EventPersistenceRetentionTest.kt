package dev.jasonpearson.automobile.sdk.persistence

import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.sdk.events.BatchDeliveryOutcome
import dev.jasonpearson.automobile.sdk.events.DefaultDropCounter
import dev.jasonpearson.automobile.sdk.events.DropReason
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class EventPersistenceRetentionTest : EventPersistenceFixture() {
  @Test
  fun `cleanup removes old batches`() {
    var now = 1_000_000_000L
    val persistence =
      FileEventPersistence(
        directory = tempFolder.root,
        clock = { now },
        uuidProvider = { "uuid" },
      )

    // Persist an old batch (timestamp = 1_000_000_000)
    persistence.persist(listOf(makeLifecycleEvent("old")))

    // Advance time by 8 days
    now += 8 * 24 * 60 * 60 * 1000L

    // Persist a new batch
    val newPersistence =
      FileEventPersistence(
        directory = tempFolder.root,
        clock = { now },
        uuidProvider = { "uuid-new" },
      )
    newPersistence.persist(listOf(makeLifecycleEvent("new")))

    // Cleanup with 7-day max age (using current time)
    newPersistence.cleanup(maxAgeDays = 7)

    val remaining = newPersistence.loadPending()
    assertEquals(1, remaining.size)
    assertEquals("new", (remaining[0].events[0] as SdkLifecycleEvent).kind)
  }

  @Test
  fun `cleanup keeps recent batches`() {
    val persistence = createPersistence(clock = { 1_000_000_000L })
    persistence.persist(listOf(makeLifecycleEvent("recent")))

    persistence.cleanup(maxAgeDays = 7)

    assertEquals(1, persistence.loadPending().size)
  }

  @Test
  fun `corrupt file is deleted and skipped`() {
    val persistence = createPersistence()

    // Write a corrupt file
    java.io.File(tempFolder.root, "events_500_corrupt.json").writeText("not valid json{{{")

    // Write a valid file
    persistence.persist(listOf(makeLifecycleEvent("valid")))

    val loaded = persistence.loadPending()
    assertEquals(1, loaded.size)
    assertEquals("valid", (loaded[0].events[0] as SdkLifecycleEvent).kind)

    // Corrupt file should have been deleted
    val remaining = tempFolder.root.listFiles { f -> f.name.contains("corrupt") }
    assertTrue(remaining.isNullOrEmpty(), "Corrupt file should be deleted")
  }

  @Test
  fun `persist cap evicts oldest files and retains newest batches`() {
    var now = 1000L
    val persistence =
      FileEventPersistence(
        directory = tempFolder.root,
        clock = { now++ },
        uuidProvider = { "id" },
        maxPendingBatches = 2,
      )
    persistence.persist(listOf(makeLifecycleEvent("first")))
    persistence.persist(listOf(makeLifecycleEvent("second")))
    persistence.persist(listOf(makeLifecycleEvent("third")))
    persistence.persist(listOf(makeLifecycleEvent("fourth")))
    assertEquals(
      listOf("third", "fourth"),
      persistence.loadPending().map {
        (it.events.single() as SdkLifecycleEvent).kind
      },
    )
    assertEquals(2, tempFolder.root.listFiles()!!.size)
  }

  @Test
  fun `cleanup counts aged out new and legacy event totals once`() {
    var now = 1000L
    val counter = DefaultDropCounter()
    val persistence = FileEventPersistence(tempFolder.root, clock = { now }, dropCounter = counter)
    persistence.persist(List(3) { makeLifecycleEvent("old") })
    writeLegacy("1000_old_uuid", List(2) { makeLifecycleEvent("legacy") })
    now += 8 * 24 * 60 * 60 * 1000L
    val recent = persistence.persist(listOf(makeLifecycleEvent("recent")))
    persistence.cleanup()
    persistence.cleanup()
    assertEquals(listOf(recent), persistence.loadPending().map { it.storageId })
    assertEquals(5L, counter.snapshot()[DropReason.DELIVERY_FAILED])
  }

  @Test
  fun `corrupt files count encoded events or one unreadable legacy event`() {
    val counter = DefaultDropCounter()
    val persistence = FileEventPersistence(tempFolder.root, dropCounter = counter)
    val id = persistence.persist(List(4) { makeLifecycleEvent("broken") })!!
    File(tempFolder.root, "events_$id.json").writeText("invalid JSON")
    File(tempFolder.root, "events_1000_corrupt.json").writeText("invalid JSON")
    assertTrue(persistence.loadPending().isEmpty())
    persistence.loadPending()
    assertEquals(5L, counter.snapshot()[DropReason.DELIVERY_FAILED])
  }

  @Test
  fun `legacy cap eviction counts JSON array length`() {
    val counter = DefaultDropCounter()
    writeLegacy("900_legacy", List(3) { makeLifecycleEvent("old") })
    val persistence =
      FileEventPersistence(tempFolder.root, maxPendingBatches = 1, dropCounter = counter)
    val retained = persistence.persist(listOf(makeLifecycleEvent("new")))
    assertEquals(listOf(retained), persistence.loadPending().map { it.storageId })
    assertEquals(3L, counter.snapshot()[DropReason.BUFFER_OVERFLOW])
  }

  @Test
  fun `failed eviction keeps new batch and stops at undeletable victim`() {
    val counter = DefaultDropCounter()
    var refuseDelete = false
    val attempted = mutableListOf<String>()
    val persistence =
      FileEventPersistence(
        tempFolder.root,
        maxPendingBatches = 1,
        dropCounter = counter,
        fileOps = { file ->
          attempted.add(file.name)
          if (refuseDelete) false else file.delete()
        },
      )
    val first = persistence.persist(listOf(makeLifecycleEvent("first")))!!
    refuseDelete = true
    val second = persistence.persist(listOf(makeLifecycleEvent("second")))!!
    val third = persistence.persist(listOf(makeLifecycleEvent("third")))!!
    assertEquals(listOf(first, second, third), persistence.loadPending().map { it.storageId })
    assertEquals(listOf("events_$first.json", "events_$first.json"), attempted)
    assertTrue(counter.snapshot().isEmpty())
  }

  @Test
  fun `already gone eviction victim is success without a drop count`() {
    val counter = DefaultDropCounter()
    val persistence =
      FileEventPersistence(
        tempFolder.root,
        maxPendingBatches = 1,
        dropCounter = counter,
        fileOps = { file ->
          assertTrue(file.delete()) // Simulate another remover winning the race.
          false
        },
      )
    persistence.persist(List(3) { makeLifecycleEvent("old") })
    val newest = persistence.persist(listOf(makeLifecycleEvent("new")))
    assertEquals(listOf(newest), persistence.loadPending().map { it.storageId })
    assertTrue(counter.snapshot().isEmpty())
  }

  @Test
  fun `failed cleanup and corrupt deletion do not count retained files`() {
    val counter = DefaultDropCounter()
    var now = 1000L
    val persistence =
      FileEventPersistence(
        tempFolder.root,
        clock = { now },
        dropCounter = counter,
        fileOps = { false },
      )
    val id = persistence.persist(List(2) { makeLifecycleEvent("old") })!!
    now = 2000L
    persistence.cleanup(maxAgeDays = 0)
    val file = File(tempFolder.root, "events_$id.json")
    file.writeText("invalid JSON")
    assertTrue(persistence.loadPending().isEmpty())
    assertTrue(file.exists())
    assertTrue(counter.snapshot().isEmpty())
  }

  @Test
  fun `persist recreates cache directory after it was cleared`() {
    val directory = File(tempFolder.root, "cache")
    val persistence = FileEventPersistence(directory, clock = { 1000L })
    persistence.persist(listOf(makeLifecycleEvent("cleared")))
    assertTrue(directory.deleteRecursively())
    assertTrue(persistence.loadPending().isEmpty())
    persistence.cleanup()
    val id = persistence.persist(listOf(makeLifecycleEvent("retained")))
    assertNotNull(id)
    assertTrue(id.startsWith("s00000000000000000002_"))
    assertEquals(listOf(id), persistence.loadPending().map { it.storageId })
  }

  @Test
  fun `byte cap evicts oldest and counts dropped events`() {
    val events = List(2) { makeLifecycleEvent("same") }
    val oneBatchBytes =
      createPersistence()
        .serializePendingBatch(events, null)
        .toByteArray(Charsets.UTF_8)
        .size
        .toLong()
    val counter = DefaultDropCounter()
    val persistence =
      FileEventPersistence(tempFolder.root, dropCounter = counter, maxPendingBytes = oneBatchBytes)
    persistence.persist(events)
    val newest = persistence.persist(events)
    assertNotNull(newest)
    assertEquals(listOf(newest), persistence.loadPending().map { it.storageId })
    assertEquals(2L, counter.snapshot()[DropReason.BUFFER_OVERFLOW])
    assertTrue(tempFolder.root.listFiles()!!.sumOf { it.length() } <= oneBatchBytes)
  }

  @Test
  fun `oversized batch is refused for buffer to count without evicting retained batch`() {
    val small = listOf(makeLifecycleEvent("small"))
    val bytes =
      createPersistence()
        .serializePendingBatch(small, null)
        .toByteArray(Charsets.UTF_8)
        .size
        .toLong()
    val persistence = FileEventPersistence(tempFolder.root, maxPendingBytes = bytes)
    val retained = persistence.persist(small)
    assertNotNull(retained)
    assertNull(persistence.persist(listOf(makeLifecycleEvent("x".repeat(1000)))))
    assertEquals(listOf(retained), persistence.loadPending().map { it.storageId })
  }

  @Test
  fun `failed invalid file removal does not starve later files or recount within pass`() {
    val persistence =
      FileEventPersistence(
        directory = tempFolder.root,
        clock = { 1000L },
        fileOps = { false },
      )
    persistence.persist(listOf(makeLifecycleEvent("invalid")))
    persistence.persist(listOf(makeLifecycleEvent("later")))
    val delivered = mutableListOf<String>()
    EventBatchReplay().replay(persistence, { it.run() }) { events, _, complete ->
      val kind = (events.single() as SdkLifecycleEvent).kind
      delivered.add(kind)
      complete(
        if (kind == "invalid") BatchDeliveryOutcome.INVALID_PAYLOAD
        else BatchDeliveryOutcome.DELIVERED,
      )
    }
    assertEquals(listOf("invalid", "later"), delivered)
    assertEquals(2, persistence.loadPending().size)
  }
}
