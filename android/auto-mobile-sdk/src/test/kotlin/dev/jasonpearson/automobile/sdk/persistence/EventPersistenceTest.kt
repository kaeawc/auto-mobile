package dev.jasonpearson.automobile.sdk.persistence

import dev.jasonpearson.automobile.protocol.NavigationSourceType
import dev.jasonpearson.automobile.protocol.SdkAnrEvent
import dev.jasonpearson.automobile.protocol.SdkBroadcastEvent
import dev.jasonpearson.automobile.protocol.SdkCrashEvent
import dev.jasonpearson.automobile.protocol.SdkDeviceInfo
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
import kotlin.test.assertEquals
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
    assertEquals("1000_test-uuid", batchId)
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
}
