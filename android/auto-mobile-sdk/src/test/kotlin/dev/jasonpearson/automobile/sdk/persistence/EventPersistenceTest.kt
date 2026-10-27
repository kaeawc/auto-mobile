package dev.jasonpearson.automobile.sdk.persistence

import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class EventPersistenceTest : EventPersistenceFixture() {
  @Test
  fun `persist returns batch ID on success`() {
    val persistence = createPersistence()
    val batchId = persistence.persist(listOf(makeLifecycleEvent("test")))
    assertNotNull(batchId)
    assertEquals("s00000000000000000001_c1_a0_t1000_test-uuid", batchId)
  }

  @Test
  fun `persist empty list returns null`() {
    val persistence = createPersistence()
    val batchId = persistence.persist(emptyList())
    assertNull(batchId)
  }

  @Test
  fun `FIFO ordering by timestamp`() {
    var counter = 0
    val persistence =
      FileEventPersistence(
        directory = tempFolder.root,
        clock = { (1000L + counter * 100).also { counter++ } },
        uuidProvider = { "uuid-$counter" },
      )

    persistence.persist(listOf(makeLifecycleEvent("first")))
    persistence.persist(listOf(makeLifecycleEvent("second")))
    persistence.persist(listOf(makeLifecycleEvent("third")))

    val loaded = persistence.loadPending()
    assertEquals(3, loaded.size)
    assertEquals("first", (loaded[0].events[0] as SdkLifecycleEvent).kind)
    assertEquals("second", (loaded[1].events[0] as SdkLifecycleEvent).kind)
    assertEquals("third", (loaded[2].events[0] as SdkLifecycleEvent).kind)
  }

  @Test
  fun `removeBatch deletes the file`() {
    val persistence = createPersistence()
    val batchId = persistence.persist(listOf(makeLifecycleEvent("to-remove")))!!

    assertEquals(1, persistence.loadPending().size)
    persistence.removeBatch(batchId)
    assertEquals(0, persistence.loadPending().size)
  }

  @Test
  fun `removeBatch with nonexistent ID does not throw`() {
    val persistence = createPersistence()
    persistence.removeBatch("nonexistent-batch-id")
    // No exception means success
  }

  @Test
  fun `loadPending returns empty list for empty directory`() {
    val persistence = createPersistence()
    assertEquals(emptyList(), persistence.loadPending())
  }

  @Test
  fun `multiple events in a single batch`() {
    val persistence = createPersistence()
    val events =
      listOf(
        makeLifecycleEvent("one", timestamp = 1L),
        makeNavEvent("home", timestamp = 2L),
        makeLifecycleEvent("two", timestamp = 3L),
      )
    persistence.persist(events)

    val loaded = persistence.loadPending()
    assertEquals(1, loaded.size)
    // Lifecycle + Nav + Lifecycle = 3 events (all deserializable types)
    assertEquals(3, loaded[0].events.size)
  }

  @Test
  fun `persist creates directory if it does not exist`() {
    val dir = java.io.File(tempFolder.root, "nested/dir")
    val persistence = FileEventPersistence(directory = dir)
    persistence.persist(listOf(makeLifecycleEvent("test")))
    assertTrue(dir.exists())
    assertEquals(1, persistence.loadPending().size)
  }

  @Test
  fun `constructor does no disk IO and missing directory reads as empty`() {
    val directory = File(tempFolder.root, "not-created")
    val persistence = FileEventPersistence(directory)
    assertFalse(directory.exists())
    assertTrue(persistence.loadPending().isEmpty())
    persistence.cleanup()
    assertFalse(directory.exists())
  }

  @Test
  fun `constructor never invokes directory operations`() {
    val directory =
      object : File(tempFolder.root, "constructor-io") {
        override fun mkdirs(): Boolean = error("Constructor must not create directories")

        override fun listFiles(): Array<File>? = error("Constructor must not scan directories")
      }
    FileEventPersistence(directory)
  }

  @Test
  fun `three argument JVM constructor remains available`() {
    val constructor =
      FileEventPersistence::class
        .java
        .getDeclaredConstructor(
          File::class.java,
          kotlin.jvm.functions.Function0::class.java,
          kotlin.jvm.functions.Function0::class.java,
        )
    val persistence = constructor.newInstance(tempFolder.root, { 1000L }, { "legacy-call" })
    assertNotNull(persistence.persist(listOf(makeLifecycleEvent("one"))))
    assertEquals(1, persistence.loadPending().size)
  }
}
