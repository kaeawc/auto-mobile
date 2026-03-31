package dev.jasonpearson.automobile.sdk.persistence

import dev.jasonpearson.automobile.protocol.NavigationSourceType
import dev.jasonpearson.automobile.protocol.SdkCustomEvent
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class EventPersistenceTest {

  @get:Rule
  val tempFolder = TemporaryFolder()

  private fun createPersistence(
    clock: () -> Long = { 1000L },
    uuidProvider: () -> String = { "test-uuid" },
  ): FileEventPersistence = FileEventPersistence(
    directory = tempFolder.root,
    clock = clock,
    uuidProvider = uuidProvider,
  )

  private fun makeCustomEvent(name: String, timestamp: Long = 100L) = SdkCustomEvent(
    timestamp = timestamp,
    applicationId = "com.test.app",
    name = name,
    properties = mapOf("key" to "value"),
  )

  private fun makeNavEvent(destination: String, timestamp: Long = 200L) = SdkNavigationEvent(
    timestamp = timestamp,
    applicationId = "com.test.app",
    destination = destination,
    source = NavigationSourceType.COMPOSE_NAVIGATION,
    arguments = mapOf("id" to "42"),
    metadata = mapOf("screen" to "home"),
  )

  @Test
  fun `persist returns batch ID on success`() {
    val persistence = createPersistence()
    val batchId = persistence.persist(listOf(makeCustomEvent("test")))
    assertNotNull(batchId)
    assertEquals("1000_test-uuid", batchId)
  }

  @Test
  fun `persist empty list returns null`() {
    val persistence = createPersistence()
    val batchId = persistence.persist(emptyList())
    assertNull(batchId)
  }

  @Test
  fun `persist and load round-trip for custom events`() {
    val persistence = createPersistence()
    val original = makeCustomEvent("round-trip", timestamp = 42L)
    persistence.persist(listOf(original))

    val loaded = persistence.loadPending()
    assertEquals(1, loaded.size)
    val (_, events) = loaded[0]
    assertEquals(1, events.size)
    val restored = events[0] as SdkCustomEvent
    assertEquals("round-trip", restored.name)
    assertEquals(42L, restored.timestamp)
    assertEquals("com.test.app", restored.applicationId)
  }

  @Test
  fun `persist and load round-trip for navigation events`() {
    val persistence = createPersistence()
    val original = makeNavEvent("settings", timestamp = 99L)
    persistence.persist(listOf(original))

    val loaded = persistence.loadPending()
    assertEquals(1, loaded.size)
    val restored = loaded[0].second[0] as SdkNavigationEvent
    assertEquals("settings", restored.destination)
    assertEquals(NavigationSourceType.COMPOSE_NAVIGATION, restored.source)
    assertEquals(99L, restored.timestamp)
    assertEquals("com.test.app", restored.applicationId)
    assertEquals(mapOf("id" to "42"), restored.arguments)
    assertEquals(mapOf("screen" to "home"), restored.metadata)
  }

  @Test
  fun `FIFO ordering by timestamp`() {
    var counter = 0
    val persistence = FileEventPersistence(
      directory = tempFolder.root,
      clock = { (1000L + counter * 100).also { counter++ } },
      uuidProvider = { "uuid-$counter" },
    )

    persistence.persist(listOf(makeCustomEvent("first")))
    persistence.persist(listOf(makeCustomEvent("second")))
    persistence.persist(listOf(makeCustomEvent("third")))

    val loaded = persistence.loadPending()
    assertEquals(3, loaded.size)
    assertEquals("first", (loaded[0].second[0] as SdkCustomEvent).name)
    assertEquals("second", (loaded[1].second[0] as SdkCustomEvent).name)
    assertEquals("third", (loaded[2].second[0] as SdkCustomEvent).name)
  }

  @Test
  fun `removeBatch deletes the file`() {
    val persistence = createPersistence()
    val batchId = persistence.persist(listOf(makeCustomEvent("to-remove")))!!

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
  fun `cleanup removes old batches`() {
    var now = 1_000_000_000L
    val persistence = FileEventPersistence(
      directory = tempFolder.root,
      clock = { now },
      uuidProvider = { "uuid" },
    )

    // Persist an old batch (timestamp = 1_000_000_000)
    persistence.persist(listOf(makeCustomEvent("old")))

    // Advance time by 8 days
    now += 8 * 24 * 60 * 60 * 1000L

    // Persist a new batch
    val newPersistence = FileEventPersistence(
      directory = tempFolder.root,
      clock = { now },
      uuidProvider = { "uuid-new" },
    )
    newPersistence.persist(listOf(makeCustomEvent("new")))

    // Cleanup with 7-day max age (using current time)
    newPersistence.cleanup(maxAgeDays = 7)

    val remaining = newPersistence.loadPending()
    assertEquals(1, remaining.size)
    assertEquals("new", (remaining[0].second[0] as SdkCustomEvent).name)
  }

  @Test
  fun `cleanup keeps recent batches`() {
    val persistence = createPersistence(clock = { 1_000_000_000L })
    persistence.persist(listOf(makeCustomEvent("recent")))

    persistence.cleanup(maxAgeDays = 7)

    assertEquals(1, persistence.loadPending().size)
  }

  @Test
  fun `corrupt file is deleted and skipped`() {
    val persistence = createPersistence()

    // Write a corrupt file
    java.io.File(tempFolder.root, "events_500_corrupt.json").writeText("not valid json{{{")

    // Write a valid file
    persistence.persist(listOf(makeCustomEvent("valid")))

    val loaded = persistence.loadPending()
    assertEquals(1, loaded.size)
    assertEquals("valid", (loaded[0].second[0] as SdkCustomEvent).name)

    // Corrupt file should have been deleted
    val remaining = tempFolder.root.listFiles { f -> f.name.contains("corrupt") }
    assertTrue(remaining.isNullOrEmpty(), "Corrupt file should be deleted")
  }

  @Test
  fun `loadPending returns empty list for empty directory`() {
    val persistence = createPersistence()
    assertEquals(emptyList(), persistence.loadPending())
  }

  @Test
  fun `multiple events in a single batch`() {
    val persistence = createPersistence()
    val events = listOf(
      makeCustomEvent("one", timestamp = 1L),
      makeNavEvent("home", timestamp = 2L),
      makeCustomEvent("two", timestamp = 3L),
    )
    persistence.persist(events)

    val loaded = persistence.loadPending()
    assertEquals(1, loaded.size)
    // Custom + Nav + Custom = 3 events (all deserializable types)
    assertEquals(3, loaded[0].second.size)
  }

  @Test
  fun `persist creates directory if it does not exist`() {
    val dir = java.io.File(tempFolder.root, "nested/dir")
    val persistence = FileEventPersistence(directory = dir)
    persistence.persist(listOf(makeCustomEvent("test")))
    assertTrue(dir.exists())
    assertEquals(1, persistence.loadPending().size)
  }
}
