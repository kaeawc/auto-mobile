package dev.jasonpearson.automobile.sdk.persistence

import dev.jasonpearson.automobile.protocol.NavigationSourceType
import dev.jasonpearson.automobile.protocol.SdkAnrEvent
import dev.jasonpearson.automobile.protocol.SdkBroadcastEvent
import dev.jasonpearson.automobile.protocol.SdkCrashEvent
import dev.jasonpearson.automobile.protocol.SdkDeviceInfo
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkHandledExceptionEvent
import dev.jasonpearson.automobile.protocol.SdkLifecycleEvent
import dev.jasonpearson.automobile.protocol.SdkLogEvent
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import dev.jasonpearson.automobile.protocol.SdkNetworkRequestEvent
import dev.jasonpearson.automobile.protocol.SdkNotificationActionEvent
import dev.jasonpearson.automobile.protocol.SdkRecompositionSnapshotEvent
import dev.jasonpearson.automobile.protocol.SdkWebSocketFrameEvent
import dev.jasonpearson.automobile.protocol.WebSocketFrameDirection
import dev.jasonpearson.automobile.protocol.WebSocketFrameType
import dev.jasonpearson.automobile.sdk.events.BatchDeliveryOutcome
import dev.jasonpearson.automobile.sdk.events.DefaultDropCounter
import dev.jasonpearson.automobile.sdk.events.DropReason
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class EventPersistenceTest {

  @get:Rule val tempFolder = TemporaryFolder()

  private fun createPersistence(
    clock: () -> Long = { 1000L },
    uuidProvider: () -> String = { "test-uuid" },
  ): FileEventPersistence =
    FileEventPersistence(
      directory = tempFolder.root,
      clock = clock,
      uuidProvider = uuidProvider,
    )

  private fun makeLifecycleEvent(name: String, timestamp: Long = 100L) =
    SdkLifecycleEvent(
      timestamp = timestamp,
      applicationId = "com.test.app",
      kind = name,
      details = mapOf("key" to "value"),
    )

  private fun makeNavEvent(destination: String, timestamp: Long = 200L) =
    SdkNavigationEvent(
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
  fun `persist and load round-trip for lifecycle events`() {
    val persistence = createPersistence()
    val original = makeLifecycleEvent("round-trip", timestamp = 42L)
    persistence.persist(listOf(original))

    val loaded = persistence.loadPending()
    assertEquals(1, loaded.size)
    val (_, events) = loaded[0]
    assertEquals(1, events.size)
    val restored = events[0] as SdkLifecycleEvent
    assertEquals("round-trip", restored.kind)
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
    assertEquals("first", (loaded[0].second[0] as SdkLifecycleEvent).kind)
    assertEquals("second", (loaded[1].second[0] as SdkLifecycleEvent).kind)
    assertEquals("third", (loaded[2].second[0] as SdkLifecycleEvent).kind)
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
    assertEquals("new", (remaining[0].second[0] as SdkLifecycleEvent).kind)
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
    assertEquals("valid", (loaded[0].second[0] as SdkLifecycleEvent).kind)

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
    assertEquals(3, loaded[0].second.size)
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
  fun `round-trip for log event`() {
    val persistence = createPersistence()
    val original =
      SdkLogEvent(
        timestamp = 300L,
        applicationId = "com.test.app",
        level = 5,
        tag = "MyTag",
        message = "Something happened",
        pid = 1234,
        tid = 5678,
      )
    persistence.persist(listOf(original))

    val restored = persistence.loadPending()[0].second[0] as SdkLogEvent
    assertEquals(300L, restored.timestamp)
    assertEquals(5, restored.level)
    assertEquals("MyTag", restored.tag)
    assertEquals("Something happened", restored.message)
    assertEquals(1234, restored.pid)
    assertEquals(5678, restored.tid)
  }

  @Test
  fun `round-trip for lifecycle event`() {
    val persistence = createPersistence()
    val original =
      SdkLifecycleEvent(
        timestamp = 400L,
        applicationId = "com.test.app",
        kind = "foreground",
        details = mapOf("activity" to "MainActivity"),
      )
    persistence.persist(listOf(original))

    val restored = persistence.loadPending()[0].second[0] as SdkLifecycleEvent
    assertEquals("foreground", restored.kind)
    assertEquals(mapOf("activity" to "MainActivity"), restored.details)
  }

  @Test
  fun `round-trip for network request event`() {
    val persistence = createPersistence()
    val original =
      SdkNetworkRequestEvent(
        timestamp = 500L,
        applicationId = "com.test.app",
        url = "https://api.example.com/data",
        method = "GET",
        statusCode = 200,
        durationMs = 150,
        host = "api.example.com",
        path = "/data",
      )
    persistence.persist(listOf(original))

    val restored = persistence.loadPending()[0].second[0] as SdkNetworkRequestEvent
    assertEquals("https://api.example.com/data", restored.url)
    assertEquals("GET", restored.method)
    assertEquals(200, restored.statusCode)
    assertEquals(150L, restored.durationMs)
    assertEquals("api.example.com", restored.host)
  }

  @Test
  fun `round-trip for crash event with device info`() {
    val persistence = createPersistence()
    val original =
      SdkCrashEvent(
        timestamp = 600L,
        applicationId = "com.test.app",
        exceptionClass = "java.lang.NullPointerException",
        exceptionMessage = "Attempt to invoke virtual method",
        stackTrace = "at com.example.Main.run(Main.kt:42)",
        threadName = "main",
        currentScreen = "HomeScreen",
        appVersion = "1.2.3",
        deviceInfo =
          SdkDeviceInfo(
            model = "Pixel 7",
            manufacturer = "Google",
            osVersion = "14",
            sdkInt = 34,
          ),
      )
    persistence.persist(listOf(original))

    val restored = persistence.loadPending()[0].second[0] as SdkCrashEvent
    assertEquals("java.lang.NullPointerException", restored.exceptionClass)
    assertEquals("Attempt to invoke virtual method", restored.exceptionMessage)
    assertEquals("main", restored.threadName)
    assertEquals("HomeScreen", restored.currentScreen)
    assertNotNull(restored.deviceInfo)
    assertEquals("Pixel 7", restored.deviceInfo!!.model)
    assertEquals(34, restored.deviceInfo!!.sdkInt)
  }

  @Test
  fun `round-trip for broadcast event`() {
    val persistence = createPersistence()
    val original =
      SdkBroadcastEvent(
        timestamp = 700L,
        applicationId = "com.test.app",
        action = "android.intent.action.BATTERY_LOW",
        categories = listOf("android.intent.category.DEFAULT"),
        extraKeys = mapOf("level" to "Int"),
      )
    persistence.persist(listOf(original))

    val restored = persistence.loadPending()[0].second[0] as SdkBroadcastEvent
    assertEquals("android.intent.action.BATTERY_LOW", restored.action)
    assertEquals(listOf("android.intent.category.DEFAULT"), restored.categories)
    assertEquals(mapOf("level" to "Int"), restored.extraKeys)
  }

  @Test
  fun `round-trip for handled exception event`() {
    val persistence = createPersistence()
    val original =
      SdkHandledExceptionEvent(
        timestamp = 800L,
        applicationId = "com.test.app",
        exceptionClass = "java.io.IOException",
        exceptionMessage = "Connection reset",
        stackTrace = "at com.example.Net.fetch(Net.kt:10)",
        customMessage = "Retry succeeded",
      )
    persistence.persist(listOf(original))

    val restored = persistence.loadPending()[0].second[0] as SdkHandledExceptionEvent
    assertEquals("java.io.IOException", restored.exceptionClass)
    assertEquals("Connection reset", restored.exceptionMessage)
    assertEquals("Retry succeeded", restored.customMessage)
  }

  @Test
  fun `round-trip for websocket frame event`() {
    val persistence = createPersistence()
    val original =
      SdkWebSocketFrameEvent(
        timestamp = 900L,
        applicationId = "com.test.app",
        connectionId = "ws-1",
        url = "wss://example.com/ws",
        direction = WebSocketFrameDirection.SENT,
        frameType = WebSocketFrameType.TEXT,
        payloadSize = 256,
      )
    persistence.persist(listOf(original))

    val restored = persistence.loadPending()[0].second[0] as SdkWebSocketFrameEvent
    assertEquals("ws-1", restored.connectionId)
    assertEquals(WebSocketFrameDirection.SENT, restored.direction)
    assertEquals(WebSocketFrameType.TEXT, restored.frameType)
    assertEquals(256L, restored.payloadSize)
  }

  @Test
  fun `round-trip for ANR event`() {
    val persistence = createPersistence()
    val original =
      SdkAnrEvent(
        timestamp = 1000L,
        applicationId = "com.test.app",
        pid = 12345,
        processName = "com.test.app",
        importance = "FOREGROUND",
        trace = "main thread trace",
        reason = "Input dispatching timed out",
      )
    persistence.persist(listOf(original))

    val restored = persistence.loadPending()[0].second[0] as SdkAnrEvent
    assertEquals(12345, restored.pid)
    assertEquals("FOREGROUND", restored.importance)
    assertEquals("main thread trace", restored.trace)
    assertEquals("Input dispatching timed out", restored.reason)
  }

  @Test
  fun `round-trip for notification action event`() {
    val persistence = createPersistence()
    val original =
      SdkNotificationActionEvent(
        timestamp = 1100L,
        applicationId = "com.test.app",
        notificationId = "notif-1",
        actionId = "reply",
        actionLabel = "Reply",
      )
    persistence.persist(listOf(original))

    val restored = persistence.loadPending()[0].second[0] as SdkNotificationActionEvent
    assertEquals("notif-1", restored.notificationId)
    assertEquals("reply", restored.actionId)
    assertEquals("Reply", restored.actionLabel)
  }

  @Test
  fun `round-trip for recomposition snapshot event`() {
    val persistence = createPersistence()
    val original =
      SdkRecompositionSnapshotEvent(
        timestamp = 1200L,
        applicationId = "com.test.app",
        snapshotJson = """{"counts":[1,2,3]}""",
      )
    persistence.persist(listOf(original))

    val restored = persistence.loadPending()[0].second[0] as SdkRecompositionSnapshotEvent
    assertEquals("""{"counts":[1,2,3]}""", restored.snapshotJson)
  }

  @Test
  fun `batch with all event types round-trips`() {
    val persistence = createPersistence()
    val events =
      listOf(
        makeLifecycleEvent("c1", timestamp = 1L),
        makeNavEvent("home", timestamp = 2L),
        SdkLogEvent(timestamp = 3L, level = 4, tag = "T", message = "m"),
        SdkLifecycleEvent(timestamp = 4L, kind = "background"),
        SdkNetworkRequestEvent(timestamp = 5L, url = "https://x.com", method = "POST"),
        SdkCrashEvent(
          timestamp = 6L,
          exceptionClass = "E",
          exceptionMessage = null,
          stackTrace = "s",
          threadName = "t",
        ),
        SdkBroadcastEvent(timestamp = 7L, action = "a"),
        SdkHandledExceptionEvent(
          timestamp = 8L,
          exceptionClass = "E",
          exceptionMessage = null,
          stackTrace = "s",
        ),
        SdkWebSocketFrameEvent(
          timestamp = 9L,
          connectionId = "c",
          url = "wss://x",
          direction = WebSocketFrameDirection.RECEIVED,
          frameType = WebSocketFrameType.BINARY,
        ),
        SdkAnrEvent(
          timestamp = 10L,
          pid = 1,
          processName = "p",
          importance = "I",
          trace = null,
          reason = "r",
        ),
        SdkNotificationActionEvent(
          timestamp = 11L,
          notificationId = "n",
          actionId = "a",
          actionLabel = "l",
        ),
        SdkRecompositionSnapshotEvent(timestamp = 12L, snapshotJson = "{}"),
      )
    persistence.persist(events)

    val loaded = persistence.loadPending()
    assertEquals(1, loaded.size)
    assertEquals(12, loaded[0].second.size, "All event types should round-trip")
  }

  @Test
  fun `unknown type key is skipped gracefully`() {
    val persistence = createPersistence()
    // Manually write a JSON file with an unknown type
    val json = """[{"type":"unknown_future_type","timestamp":1,"applicationId":""}]"""
    java.io.File(tempFolder.root, "events_1000_test-uuid.json").writeText(json)

    val loaded = persistence.loadPending()
    assertEquals(1, loaded.size)
    assertEquals(0, loaded[0].second.size, "Unknown type should be skipped, not throw")
  }

  @Test
  fun `type key uses stable string not class name`() {
    val persistence = createPersistence()
    persistence.persist(listOf(makeLifecycleEvent("test")))

    val file = tempFolder.root.listFiles()!!.first()
    val json = file.readText()
    assertTrue(
      json.contains(""""type":"lifecycle""""),
      "Should use stable key 'lifecycle', not class simpleName",
    )
    assertTrue(!json.contains("SdkLifecycleEvent"), "Should not contain class name")
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
        (it.second.single() as SdkLifecycleEvent).kind
      },
    )
    assertEquals(2, tempFolder.root.listFiles()!!.size)
  }

  private class ReplayPersistence(val pending: List<Pair<String, List<SdkEvent>>>) :
    EventPersistence {
    val removed = mutableListOf<String>()
    var persistCalls = 0

    override fun persist(events: List<SdkEvent>): String? {
      persistCalls++
      return "duplicate"
    }

    override fun loadPending(): List<Pair<String, List<SdkEvent>>> = pending

    override fun removeBatch(batchId: String) {
      removed.add(batchId)
    }

    override fun cleanup(maxAgeDays: Int) {}
  }

  @Test
  fun `replay removes only successful batches in oldest first submission order`() {
    val first: List<SdkEvent> = listOf(makeLifecycleEvent("first"))
    val second: List<SdkEvent> = listOf(makeLifecycleEvent("second"))
    val persistence = ReplayPersistence(listOf("oldest" to first, "newest" to second))
    val submitted = mutableListOf<List<SdkEvent>>()
    val completions = mutableListOf<(Boolean) -> Unit>()
    replayEventBatches(persistence, { it.run() }) { events, complete ->
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
    replayEventBatches(persistence, { it.run() }) { _, _ -> throw IllegalStateException("failure") }
    assertTrue(persistence.removed.isEmpty())
    assertEquals(0, persistence.persistCalls)
  }

  @Test
  fun `replay contains load and remove persistence failures`() {
    val unreadable =
      object : EventPersistence {
        override fun persist(events: List<SdkEvent>): String? = null

        override fun loadPending(): List<Pair<String, List<SdkEvent>>> =
          throw IllegalStateException("read failure")

        override fun removeBatch(batchId: String) {
          error("not reached")
        }

        override fun cleanup(maxAgeDays: Int) {}
      }
    var submitted = false
    replayEventBatches(unreadable, { it.run() }) { _, _ -> submitted = true }
    assertTrue(!submitted)
    val unremovable =
      object : EventPersistence {
        override fun persist(events: List<SdkEvent>): String? = null

        override fun loadPending(): List<Pair<String, List<SdkEvent>>> =
          listOf("id" to listOf<SdkEvent>(makeLifecycleEvent("one")))

        override fun removeBatch(batchId: String) {
          throw IllegalStateException("remove failure")
        }

        override fun cleanup(maxAgeDays: Int) {}
      }
    var complete: ((Boolean) -> Unit)? = null
    replayEventBatches(unremovable, { it.run() }) { _, callback -> complete = callback }
    complete!!(true)
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
    assertEquals(listOf(newest), persistence.loadPending().map { it.first })
    assertEquals(3L, counter.snapshot()[DropReason.BUFFER_OVERFLOW])
  }

  @Test
  fun `clock regression preserves arrival order with room for both batches`() {
    var now = 2000L
    val persistence = FileEventPersistence(tempFolder.root, clock = { now })
    val first = persistence.persist(listOf(makeLifecycleEvent("first")))
    now = 1000L
    val second = persistence.persist(listOf(makeLifecycleEvent("second")))
    assertEquals(listOf(first, second), persistence.loadPending().map { it.first })
  }

  @Test
  fun `equal timestamps ignore opposite UUID order including underscores`() {
    var uuid = "z_uuid-with-dash"
    val persistence =
      FileEventPersistence(tempFolder.root, clock = { 1000L }, uuidProvider = { uuid })
    val first = persistence.persist(listOf(makeLifecycleEvent("first")))
    uuid = "a_uuid-with-dash"
    val second = persistence.persist(listOf(makeLifecycleEvent("second")))
    assertEquals(listOf(first, second), persistence.loadPending().map { it.first })
  }

  @Test
  fun `sequence recovered across instances and lazily before first write`() {
    val oldInstance = createPersistence(clock = { 2000L })
    val newInstance = createPersistence(clock = { 1000L })
    val first = oldInstance.persist(listOf(makeLifecycleEvent("first")))
    val second = oldInstance.persist(listOf(makeLifecycleEvent("second")))
    val third = newInstance.persist(listOf(makeLifecycleEvent("third")))
    assertTrue(third!!.startsWith("s00000000000000000003_"))
    assertEquals(listOf(first, second, third), newInstance.loadPending().map { it.first })
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

  private fun writeLegacy(id: String, events: List<SdkEvent>) {
    File(tempFolder.root, "events_$id.json").writeText(createPersistence().serializeEvents(events))
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
      persistence.loadPending().map { it.first },
    )
    persistence.removeBatch("20_a_uuid")
    assertEquals(
      listOf("9_b_uuid", "20_z_uuid", newest),
      persistence.loadPending().map { it.first },
    )
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
    assertEquals(listOf(recent), persistence.loadPending().map { it.first })
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
    assertEquals(listOf(retained), persistence.loadPending().map { it.first })
    assertEquals(3L, counter.snapshot()[DropReason.BUFFER_OVERFLOW])
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
    val failedOnce = reloaded.loadPending().first().first
    assertTrue(failedOnce.contains("_a1_"))
    assertEquals(
      listOf("first", "second"),
      reloaded.loadPending().map {
        (it.second.first() as SdkLifecycleEvent).kind
      },
    )
    assertTrue(reloaded.recordReplayFailure(failedOnce))
    val thirdInstance = instance()
    val failedTwice = thirdInstance.loadPending().first().first
    assertTrue(failedTwice.contains("_a2_"))
    assertFalse(thirdInstance.recordReplayFailure(failedTwice))
    assertEquals(listOf(second), thirdInstance.loadPending().map { it.first })
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
      replayEventBatches(persistence, { it.run() }) { _, complete -> complete(false) }
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
      loaded.map { (it.second.first() as SdkLifecycleEvent).kind },
    )
    assertFalse(reloaded.recordReplayFailure(loaded[1].first))
    assertEquals(2L, counter.snapshot()[DropReason.DELIVERY_FAILED])
    reloaded.removeBatch(loaded[0].first)
    assertEquals(listOf(newest), reloaded.loadPending().map { it.first })
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
    assertEquals(listOf(first, second, third), persistence.loadPending().map { it.first })
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
    assertEquals(listOf(newest), persistence.loadPending().map { it.first })
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
    assertEquals(listOf(id), persistence.loadPending().map { it.first })
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
    assertEquals(listOf(id), persistence.loadPending().map { it.first })
  }

  @Test
  fun `byte cap evicts oldest and counts dropped events`() {
    val events = List(2) { makeLifecycleEvent("same") }
    val oneBatchBytes =
      createPersistence().serializeEvents(events).toByteArray(Charsets.UTF_8).size.toLong()
    val counter = DefaultDropCounter()
    val persistence =
      FileEventPersistence(tempFolder.root, dropCounter = counter, maxPendingBytes = oneBatchBytes)
    persistence.persist(events)
    val newest = persistence.persist(events)
    assertNotNull(newest)
    assertEquals(listOf(newest), persistence.loadPending().map { it.first })
    assertEquals(2L, counter.snapshot()[DropReason.BUFFER_OVERFLOW])
    assertTrue(tempFolder.root.listFiles()!!.sumOf { it.length() } <= oneBatchBytes)
  }

  @Test
  fun `oversized batch is refused for buffer to count without evicting retained batch`() {
    val small = listOf(makeLifecycleEvent("small"))
    val bytes = createPersistence().serializeEvents(small).toByteArray(Charsets.UTF_8).size.toLong()
    val persistence = FileEventPersistence(tempFolder.root, maxPendingBytes = bytes)
    val retained = persistence.persist(small)
    assertNotNull(retained)
    assertNull(persistence.persist(listOf(makeLifecycleEvent("x".repeat(1000)))))
    assertEquals(listOf(retained), persistence.loadPending().map { it.first })
  }

  @Test
  fun `unavailable replay across launches preserves file identity and attempt count`() {
    val persistence = createPersistence()
    val id = persistence.persist(listOf(makeLifecycleEvent("retained")))!!
    repeat(4) {
      EventBatchReplay().replay(persistence, { it.run() }) { _, complete ->
        complete(BatchDeliveryOutcome.UNDELIVERED)
      }
    }
    assertEquals(listOf(id), persistence.loadPending().map { it.first })
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
    EventBatchReplay().replay(persistence, { it.run() }) { events, complete ->
      val kind = (events.single() as SdkLifecycleEvent).kind
      delivered.add(kind)
      complete(
        if (kind == "invalid") BatchDeliveryOutcome.INVALID_PAYLOAD
        else BatchDeliveryOutcome.DELIVERED
      )
    }
    assertEquals(listOf("invalid", "later"), delivered)
    assertEquals(2, persistence.loadPending().size)
  }
}
