package dev.jasonpearson.automobile.sdk.persistence

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.sdk.events.BatchDeliveryOutcome
import dev.jasonpearson.automobile.sdk.events.DefaultDropCounter
import dev.jasonpearson.automobile.sdk.events.DropReason
import dev.jasonpearson.automobile.sdk.events.SdkEventBroadcaster
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class EventPersistenceReplayTest : EventPersistenceFixture() {
  @Test
  fun `timed out batch retains id through persistence reload replay and failed deletion`() {
    val delivery = IdentityDeliveryFixture()
    try {
      val persistence = createPersistence()
      SdkEventBroadcaster.broadcastBatch(
        delivery.context,
        listOf(makeLifecycleEvent("pending")),
        onUndelivered = { events, id -> persistence.persist(events, id) },
      )
      delivery.timeout!!.run()
      delivery.lateResult!!(1000)
      assertEquals(listOf<String?>("stable-id"), delivery.ids)
      val reloaded = FileEventPersistence(tempFolder.root, clock = { 1000L }, fileOps = { false })
      assertEquals("stable-id", reloaded.loadPending().single().deliveryId)
      delivery.accepted = true
      repeat(2) { delivery.replay(reloaded) }
      assertEquals(List<String?>(3) { "stable-id" }, delivery.ids)
      assertEquals(1, reloaded.loadPending().size)
    } finally {
      SdkEventBroadcaster.reset()
    }
  }

  @Test
  fun `old array file loads and replays without an id`() {
    val delivery = IdentityDeliveryFixture()
    try {
      val persistence = createPersistence()
      writeLegacy("1000_old", listOf(makeLifecycleEvent("legacy")))
      assertEquals(null, persistence.loadPending().single().deliveryId)
      delivery.accepted = true
      delivery.replay(persistence)
      assertEquals(listOf<String?>(null), delivery.ids)
      assertTrue(persistence.loadPending().isEmpty())
    } finally {
      SdkEventBroadcaster.reset()
    }
  }

  @Test
  fun `object file with null batch id loads and replays without an id`() {
    val delivery = IdentityDeliveryFixture()
    try {
      val persistence = createPersistence()
      val events = listOf(makeLifecycleEvent("no-id"))
      File(tempFolder.root, "events_1000_null-id.json")
        .writeText("""{"batchId":null,"events":${persistence.serializeEvents(events)}}""")
      val loaded = persistence.loadPending().single()
      assertEquals(events, loaded.events)
      assertNull(loaded.deliveryId)
      delivery.accepted = true
      delivery.replay(persistence)
      assertEquals(listOf<String?>(null), delivery.ids)
      assertTrue(persistence.loadPending().isEmpty())
    } finally {
      SdkEventBroadcaster.reset()
    }
  }

  @Test
  fun `corrupt and partial object files are deleted counted and never replayed`() {
    val delivery = IdentityDeliveryFixture()
    try {
      val counter = DefaultDropCounter()
      val persistence =
        FileEventPersistence(tempFolder.root, clock = { 1000L }, dropCounter = counter)
      val invalidFiles =
        listOf(
            """{"batchId":"corrupt","events":{}}""",
            """{"batchId":"partial","events":[""",
            """{"batchId":"missing-events"}""",
          )
          .mapIndexed { index, json ->
            File(tempFolder.root, "events_1000_invalid-$index.json").apply { writeText(json) }
          }
      val validId = persistence.persist(listOf(makeLifecycleEvent("valid")), "valid-id")
      assertEquals(listOf(validId), persistence.loadPending().map { it.storageId })
      assertTrue(invalidFiles.none { it.exists() })
      assertEquals(3L, counter.snapshot()[DropReason.DELIVERY_FAILED])
      delivery.accepted = true
      delivery.replay(persistence)
      assertEquals(listOf<String?>("valid-id"), delivery.ids)
      assertTrue(persistence.loadPending().isEmpty())
      assertEquals(3L, counter.snapshot()[DropReason.DELIVERY_FAILED])
    } finally {
      SdkEventBroadcaster.reset()
    }
  }

  @Test
  fun `retry rename preserves persisted delivery id`() {
    val persistence = createPersistence()
    val storageId = persistence.persist(listOf(makeLifecycleEvent("retry")), "delivery-id")!!
    assertTrue(persistence.recordReplayFailure(storageId))
    val loaded = createPersistence().loadPending().single()
    assertTrue(loaded.storageId.contains("_a1_"))
    assertEquals("delivery-id", loaded.deliveryId)
  }

  @Test
  fun `replay removes only successful batches in oldest first submission order`() {
    val first: List<SdkEvent> = listOf(makeLifecycleEvent("first"))
    val second: List<SdkEvent> = listOf(makeLifecycleEvent("second"))
    val persistence = ReplayPersistence(listOf("oldest" to first, "newest" to second))
    val submitted = mutableListOf<List<SdkEvent>>()
    val completions = mutableListOf<(Boolean) -> Unit>()
    replayEventBatches(persistence, { it.run() }) { events, _, complete ->
      submitted.add(events)
      completions.add(complete)
    }
    assertEquals(listOf(first), submitted)
    assertTrue(persistence.removed.isEmpty())
    completions[0](true)
    assertEquals(listOf(first, second), submitted)
    completions[1](false)
    assertEquals(listOf("oldest"), persistence.removed)
    assertEquals(0, persistence.persistCalls)
  }

  @Test
  fun `replay submission failure keeps original without repersisting`() {
    val persistence = ReplayPersistence(listOf("id" to listOf(makeLifecycleEvent("one"))))
    replayEventBatches(persistence, { it.run() }) { _, _, _ ->
      throw IllegalStateException("failure")
    }
    assertTrue(persistence.removed.isEmpty())
    assertEquals(0, persistence.persistCalls)
  }

  @Test
  fun `replay contains load and remove persistence failures`() {
    val unreadable =
      object : NoOpEventPersistence() {
        override fun persist(events: List<SdkEvent>, deliveryId: String?): String? = null

        override fun loadPending(): List<PendingEventBatch> =
          throw IllegalStateException("read failure")

        override fun removeBatch(batchId: String) {
          error("not reached")
        }
      }
    var submitted = false
    replayEventBatches(unreadable, { it.run() }) { _, _, _ -> submitted = true }
    assertTrue(!submitted)
    val unremovable =
      object : NoOpEventPersistence() {
        override fun persist(events: List<SdkEvent>, deliveryId: String?): String? = null

        override fun loadPending(): List<PendingEventBatch> =
          listOf(PendingEventBatch("id", listOf<SdkEvent>(makeLifecycleEvent("one"))))

        override fun removeBatch(batchId: String) {
          throw IllegalStateException("remove failure")
        }
      }
    var complete: ((Boolean) -> Unit)? = null
    replayEventBatches(unremovable, { it.run() }) { _, _, callback -> complete = callback }
    complete!!(true)
  }

  @Test
  fun `replay failures preserve order and persist attempts across instances until cap`() {
    val counter = DefaultDropCounter()
    fun instance() =
      FileEventPersistence(
        tempFolder.root,
        clock = { 1000L },
        dropCounter = counter,
        maxReplayAttempts = 3,
      )
    val persistence = instance()
    val first = persistence.persist(List(2) { makeLifecycleEvent("first") })!!
    val second = persistence.persist(listOf(makeLifecycleEvent("second")))!!
    assertTrue(persistence.recordReplayFailure(first))
    val reloaded = instance()
    val failedOnce = reloaded.loadPending().first().storageId
    assertTrue(failedOnce.contains("_a1_"))
    assertEquals(
      listOf("first", "second"),
      reloaded.loadPending().map {
        (it.events.first() as SdkLifecycleEvent).kind
      },
    )
    assertTrue(reloaded.recordReplayFailure(failedOnce))
    val thirdInstance = instance()
    val failedTwice = thirdInstance.loadPending().first().storageId
    assertTrue(failedTwice.contains("_a2_"))
    assertFalse(thirdInstance.recordReplayFailure(failedTwice))
    assertEquals(listOf(second), thirdInstance.loadPending().map { it.storageId })
    assertEquals(2L, counter.snapshot()[DropReason.DELIVERY_FAILED])
    assertFalse(thirdInstance.recordReplayFailure(failedTwice))
    assertEquals(2L, counter.snapshot()[DropReason.DELIVERY_FAILED])
  }

  @Test
  fun `failed replay launches consume persisted attempts and drop at configured cap`() {
    val counter = DefaultDropCounter()
    fun instance() =
      FileEventPersistence(tempFolder.root, dropCounter = counter, maxReplayAttempts = 3)
    instance().persist(List(3) { makeLifecycleEvent("failed") })
    repeat(3) { launch ->
      val persistence = instance()
      replayEventBatches(persistence, { it.run() }) { _, _, complete -> complete(false) }
      assertEquals(if (launch == 2) 0 else 1, persistence.loadPending().size)
    }
    assertEquals(3L, counter.snapshot()[DropReason.DELIVERY_FAILED])
  }

  @Test
  fun `legacy replay rename retains exact legacy position and counts cap drop`() {
    val counter = DefaultDropCounter()
    val persistence =
      FileEventPersistence(
        tempFolder.root,
        clock = { 1L },
        dropCounter = counter,
        maxReplayAttempts = 2,
      )
    writeLegacy("1000_z_with_underscores", List(2) { makeLifecycleEvent("z") })
    writeLegacy("1000_a_with_underscores", listOf(makeLifecycleEvent("a")))
    val newest = persistence.persist(listOf(makeLifecycleEvent("new")))!!
    assertTrue(persistence.recordReplayFailure("1000_z_with_underscores"))
    assertTrue(persistence.recordReplayFailure("1000_a_with_underscores"))
    val reloaded =
      FileEventPersistence(tempFolder.root, dropCounter = counter, maxReplayAttempts = 2)
    val loaded = reloaded.loadPending()
    assertEquals(
      listOf("a", "z", "new"),
      loaded.map { (it.events.first() as SdkLifecycleEvent).kind },
    )
    assertFalse(reloaded.recordReplayFailure(loaded[1].storageId))
    assertEquals(2L, counter.snapshot()[DropReason.DELIVERY_FAILED])
    reloaded.removeBatch(loaded[0].storageId)
    assertEquals(listOf(newest), reloaded.loadPending().map { it.storageId })
  }

  @Test
  fun `cleanup uses original timestamp after legacy retry rename`() {
    val counter = DefaultDropCounter()
    writeLegacy("1000_legacy", List(2) { makeLifecycleEvent("old") })
    val persistence =
      FileEventPersistence(
        tempFolder.root,
        clock = { 8 * 24 * 60 * 60 * 1000L },
        dropCounter = counter,
      )
    assertTrue(persistence.recordReplayFailure("1000_legacy"))
    persistence.cleanup()
    assertTrue(persistence.loadPending().isEmpty())
    assertEquals(2L, counter.snapshot()[DropReason.DELIVERY_FAILED])
  }

  @Test
  fun `failed replay cap deletion retains batch without counting a drop`() {
    val counter = DefaultDropCounter()
    val persistence =
      FileEventPersistence(
        tempFolder.root,
        maxReplayAttempts = 1,
        dropCounter = counter,
        fileOps = { false },
      )
    val id = persistence.persist(List(2) { makeLifecycleEvent("retained") })!!
    assertTrue(persistence.recordReplayFailure(id))
    assertEquals(listOf(id), persistence.loadPending().map { it.storageId })
    assertTrue(counter.snapshot().isEmpty())
  }

  @Test
  fun `unavailable replay across launches preserves file identity and attempt count`() {
    val persistence = createPersistence()
    val id = persistence.persist(listOf(makeLifecycleEvent("retained")))!!
    repeat(4) {
      EventBatchReplay().replay(persistence, { it.run() }) { _, _, complete ->
        complete(BatchDeliveryOutcome.UNDELIVERED)
      }
    }
    assertEquals(listOf(id), persistence.loadPending().map { it.storageId })
  }
}
