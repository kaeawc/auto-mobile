package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.HierarchyUpdateEvent
import dev.jasonpearson.automobile.protocol.OverlayEvent
import dev.jasonpearson.automobile.protocol.OverlayEventKind
import dev.jasonpearson.automobile.protocol.OverlayResult
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.RequestHierarchyIfStale
import dev.jasonpearson.automobile.protocol.SetKeyboardProfileResult
import dev.jasonpearson.automobile.protocol.SetNetworkMockRules
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult
import dev.jasonpearson.automobile.protocol.SwipeResult
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Unit tests for WebSocketServer that verify basic functionality:
 * - Server lifecycle (start/stop)
 * - Server state management
 *
 * Note: Full integration tests with actual network I/O are in WebSocketServerIntegrationTest
 */
@RunWith(RobolectricTestRunner::class)
class WebSocketServerTest {

  @Test
  fun `inbound frame log omits user text including malformed payloads`() {
    val frame = """{"type":"request_commit_text","text":"hunter2","requestId":"secret"}"""
    val line = WebSocketServer.inboundFrameLogLine(7, frame)
    assertEquals("Received from client #7: type=request_commit_text length=${frame.length}", line)
    assertFalse(line.contains("hunter2"))
    assertFalse(line.contains("secret"))
    assertFalse(WebSocketServer.inboundFrameLogLine(7, "hunter2").contains("hunter2"))
  }

  @Test
  fun `typed-input parse failure log omits the frame and the decoder message`() {
    val frame = """{"type":"request_commit_text","text":"hunter2","requestId":7}"""
    val error = IllegalArgumentException("Unexpected JSON token at offset 40: $frame")
    val line = WebSocketServer.textInputParseFailureLogLine(frame, "request_commit_text", error)
    assertEquals(
      "Failed to parse request_commit_text (${frame.length} chars): IllegalArgumentException",
      line,
    )
    assertNull(
      WebSocketServer.textInputParseFailureLogLine(frame, "request_tap_coordinates", error)
    )
  }

  private lateinit var server: WebSocketServer
  private lateinit var testScope: TestScope

  @Before
  fun setUp() {
    testScope = TestScope()
    // Use port 0 to let OS assign an available port, avoiding conflicts when tests run in parallel
    server = WebSocketServer(port = 0, scope = testScope)
  }

  @After
  fun tearDown() {
    if (server.isRunning()) {
      server.stop()
    }
    testScope.cancel()
  }

  @Test
  fun `disconnect count captures zero edge before reconnect and carries old observer generation`() =
    runTest {
      val changes = mutableListOf<Pair<Int, Int>>()
      var reconnected: WebSocketServer.ConnectedClient? = null
      server =
        WebSocketServer(
          port = 0,
          scope = this,
          onClientDisconnected = { client ->
            if (client.id == 2) reconnected = server.registerClient(3, RecordingTransport())
          },
          onClientCountChanged = { count, session -> changes += count to session },
        )
      val first = server.registerClient(1, RecordingTransport())
      val second = server.registerClient(2, RecordingTransport())
      server.unregisterClient(first)
      server.unregisterClient(second)
      server.unregisterClient(second)
      assertEquals(listOf(1 to 1, 0 to 1), changes)
      assertEquals(1, server.getConnectionCount())
      assertEquals(2, server.observerSessionGeneration())
      server.unregisterClient(checkNotNull(reconnected))
      assertEquals(listOf(1 to 1, 0 to 1, 0 to 2), changes)
    }

  @Test
  fun `display gestures are advertised only on supported Android versions`() {
    for (sdk in listOf(29, 30, 36)) {
      val commands =
        WebSocketServer(port = 0, scope = testScope, sdkInt = { sdk }).supportedCommands()
      assertEquals(
        "Gesture display capability on API $sdk",
        sdk >= 30,
        commands.contains("gesture_display_id_v1"),
      )
      assertTrue(commands.contains("request_insert_text"))
      assertTrue(commands.contains("discover_keystore"))
      assertFalse(commands.contains("request_press_key"))
    }
  }

  @Test
  fun `server starts successfully`() =
    runTest(testScope.testScheduler) {
      // Given
      assertFalse("Server should not be running initially", server.isRunning())

      // When
      server.start()
      runCurrent()

      // Then
      assertTrue("Server should be running", server.isRunning())
      assertEquals("Should have no connections initially", 0, server.getConnectionCount())
    }

  @Test
  fun `server retries a failed bind and starts when port becomes available`() =
    runTest(testScope.testScheduler) {
      var permanentFailures = 0
      var available = false
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          onPermanentStartFailure = { permanentFailures++ },
          portAvailable = { available },
        )

      server.start()
      assertFalse("Failed initial bind must not report a listener", server.isRunning())
      runCurrent()
      advanceTimeBy(249)
      assertFalse("Server must stay stopped during backoff", server.isRunning())

      available = true
      advanceTimeBy(1)
      runCurrent()
      assertTrue("First retry should bind after the port is freed", server.isRunning())
      assertEquals(0, permanentFailures)
    }

  @Test
  fun `injected occupied port probe prevents ktor startup without a blocker socket`() =
    runTest(testScope.testScheduler) {
      var probes = 0
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          portAvailable = {
            probes++
            false
          },
        )

      server.start()
      runCurrent()

      assertEquals(1, probes)
      assertFalse(server.isRunning())
    }

  @Test
  fun `server reports permanent failure once after bounded retries`() =
    runTest(testScope.testScheduler) {
      var permanentFailures = 0
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          onPermanentStartFailure = { permanentFailures++ },
          portAvailable = { false },
        )

      server.start()
      assertFalse(server.isRunning())
      runCurrent()
      advanceUntilIdle()

      assertFalse("Exhausted retries must not report a listener", server.isRunning())
      assertEquals("Permanent failure callback should fire once", 1, permanentFailures)
      assertEquals(
        "Four exponential delays should total 3750 ms",
        3750L,
        testScheduler.currentTime,
      )
    }

  @Test
  fun `explicit successful start cancels pending permanent failure`() =
    runTest(testScope.testScheduler) {
      var permanentFailures = 0
      var available = false
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          onPermanentStartFailure = { permanentFailures++ },
          portAvailable = { available },
        )

      server.start()
      assertFalse(server.isRunning())
      runCurrent()
      available = true
      server.start()
      runCurrent()
      advanceUntilIdle()

      assertTrue(server.isRunning())
      assertEquals(0, permanentFailures)
    }

  @Test
  fun `stop cancels a pending retry without reporting permanent failure`() =
    runTest(testScope.testScheduler) {
      var permanentFailures = 0
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          onPermanentStartFailure = { permanentFailures++ },
          portAvailable = { false },
        )

      server.start()
      runCurrent()
      assertFalse(server.isRunning())
      server.stop()
      advanceTimeBy(4_000)
      runCurrent()

      assertFalse("Stopped server must not bind after retry delay", server.isRunning())
      assertEquals(0, permanentFailures)
    }

  @Test
  fun `cancel while retry enters start lock cannot resurrect listener`() =
    runTest(testScope.testScheduler) {
      var available = false
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          portAvailable = { available },
          onRetryLockAcquired = {
            available = true
            server.stop()
          },
        )

      server.start()
      runCurrent()
      advanceTimeBy(250)
      runCurrent()

      assertFalse("A canceled retry must not bind after stop", server.isRunning())
    }

  @Test
  fun `server stops successfully`() =
    runTest(testScope.testScheduler) {
      // Given
      server.start()
      runCurrent()
      assertTrue(server.isRunning())

      // When
      server.stop()

      // Then
      assertFalse("Server should be stopped", server.isRunning())
    }

  @Test
  fun `server does not start twice`() =
    runTest(testScope.testScheduler) {
      // Given
      server.start()
      runCurrent()

      // When - try to start again
      server.start()

      // Then - should still be running normally
      assertTrue("Server should still be running", server.isRunning())
    }

  @Test
  fun `server connection count starts at zero`() =
    runTest(testScope.testScheduler) {
      // Given
      server.start()
      runCurrent()

      // Then
      assertEquals("Connection count should start at 0", 0, server.getConnectionCount())
    }

  @Test
  fun `stalled outbound send disconnects exactly at its deadline`() =
    runTest(testScope.testScheduler) {
      val timeoutMs = 100L
      server = WebSocketServer(port = 0, scope = testScope, sendTimeoutMs = timeoutMs)
      val stalled = StalledTransport()
      server.registerClient(1, stalled)
      server.broadcast("in-flight")
      runCurrent()

      advanceTimeBy(timeoutMs - 1)
      runCurrent()
      assertEquals(1, server.getConnectionCount())
      assertNull(stalled.closeReason)

      advanceTimeBy(1)
      runCurrent()
      assertEquals(0, server.getConnectionCount())
      assertEquals(CloseReason.Codes.TRY_AGAIN_LATER.code, stalled.closeReason?.code)
      assertEquals("Outbound send timed out", stalled.closeReason?.message)
      assertTrue(stalled.messages.isEmpty())
    }

  @Test
  fun `completed outbound sends stay connected beyond the deadline`() =
    runTest(testScope.testScheduler) {
      val timeoutMs = 100L
      server = WebSocketServer(port = 0, scope = testScope, sendTimeoutMs = timeoutMs)
      val healthy = RecordingTransport()
      server.registerClient(1, healthy)
      val messages = listOf("first", "second", "third")
      messages.forEach { server.broadcast(it) }
      runCurrent()

      advanceTimeBy(timeoutMs * 10)
      runCurrent()
      assertEquals(messages, healthy.messages)
      assertEquals(1, server.getConnectionCount())
      server.broadcast("after-deadline")
      runCurrent()
      assertEquals(messages + "after-deadline", healthy.messages)
    }

  @Test
  fun `outbound send cancellation propagates without timeout cleanup`() =
    runTest(testScope.testScheduler) {
      val cancelled = StalledTransport()
      val cancellation = CancellationException("Transport cancelled")
      val client =
        server.registerClient(
          1,
          object : WebSocketServer.ClientTransport by cancelled {
            override suspend fun send(message: String) {
              throw cancellation
            }
          },
        )
      var completionCause: Throwable? = null
      client.sender.invokeOnCompletion { completionCause = it }
      server.broadcast("cancelled")
      runCurrent()

      assertTrue(client.sender.isCancelled)
      assertTrue(completionCause is CancellationException)
      assertEquals(cancellation.message, completionCause?.message)
      assertEquals(1, server.getConnectionCount())
      assertNull(cancelled.closeReason)
    }

  @Test
  fun `outbound timeout disconnects only the stalled client`() =
    runTest(testScope.testScheduler) {
      val timeoutMs = 100L
      server = WebSocketServer(port = 0, scope = testScope, sendTimeoutMs = timeoutMs)
      val stalled = StalledTransport()
      val healthy = RecordingTransport()
      server.registerClient(1, stalled)
      val healthyClient = server.registerClient(2, healthy)
      server.broadcast("shared")
      runCurrent()

      advanceTimeBy(timeoutMs + 1)
      runCurrent()
      assertEquals(1, server.getConnectionCount())
      assertEquals(listOf("shared"), healthy.messages)
      assertEquals(CloseReason.Codes.TRY_AGAIN_LATER.code, stalled.closeReason?.code)
      assertFalse(healthyClient.sender.isCancelled)
    }

  @Test
  fun `frames after outbound timeout complete without advancing time`() =
    runTest(testScope.testScheduler) {
      val timeoutMs = 100L
      server = WebSocketServer(port = 0, scope = testScope, sendTimeoutMs = timeoutMs)
      val stalled = StalledTransport()
      val healthy = RecordingTransport()
      val stalledClient = server.registerClient(1, stalled)
      server.registerClient(2, healthy)
      server.broadcast("in-flight")
      runCurrent()
      server.sendToClient(stalledClient, "pending")
      advanceTimeBy(timeoutMs)
      runCurrent()
      assertEquals(1, server.getConnectionCount())
      assertEquals(0, stalledClient.pendingCount)

      val timeAfterTimeout = testScheduler.currentTime
      val broadcasting = launch {
        server.broadcast("after-timeout")
        server.sendToClient(stalledClient, "removed-client")
      }
      runCurrent()
      assertTrue(broadcasting.isCompleted)
      assertFalse(broadcasting.isCancelled)
      assertEquals(timeAfterTimeout, testScheduler.currentTime)
      assertEquals(listOf("in-flight", "after-timeout"), healthy.messages)
      stalled.unblock()
      runCurrent()
      assertTrue(stalled.messages.isEmpty())
      assertTrue(stalledClient.sender.isCompleted)
    }

  @Test
  fun `outbound timeout clears only the stalled clients request owners`() =
    runTest(testScope.testScheduler) {
      val timeoutMs = 100L
      server = WebSocketServer(port = 0, scope = testScope, sendTimeoutMs = timeoutMs)
      val owner = server.registerClient(1, StalledTransport())
      val healthyOwner = server.registerClient(2, RecordingTransport())
      server.registerRequestOwner("stalled-request", owner)
      server.registerRequestOwner("healthy-request", healthyOwner)
      server.sendToClient(owner, "in-flight")
      runCurrent()
      assertTrue(server.hasRequestOwner("stalled-request"))

      advanceTimeBy(timeoutMs)
      runCurrent()
      assertFalse(server.hasRequestOwner("stalled-request"))
      assertTrue(server.hasRequestOwner("healthy-request"))
      assertEquals(1, server.getConnectionCount())
    }

  @Test
  fun `droppable burst sheds frames and preserves correlated response after a brief stall`() =
    runTest(testScope.testScheduler) {
      val stalled = StalledTransport()
      val client = server.registerClient(1, stalled)
      server.broadcast("in-flight")
      runCurrent()

      repeat(WebSocketServer.OUTGOING_CAPACITY + 80) { index ->
        val type = if (index % 2 == 0) "log_event" else "network_event"
        server.broadcast("""{"type":"$type","index":$index}""")
      }
      val response = """{"type":"action_result","requestId":"awaited"}"""
      server.sendToClient(client, response)

      assertEquals(1, server.getConnectionCount())
      assertNull(stalled.closeReason)
      assertTrue(client.droppedCount > 0)
      assertEquals(WebSocketServer.OUTGOING_CAPACITY, client.pendingCount)
      stalled.unblock()
      runCurrent()
      assertEquals("in-flight", stalled.messages.first())
      assertFalse(stalled.messages.contains("""{"type":"log_event","index":0}"""))
      assertTrue(stalled.messages.contains("""{"type":"network_event","index":143}"""))
      assertEquals(response, stalled.messages.last())
    }

  @Test
  fun `correlated response uses reserve behind must deliver frames`() =
    runTest(testScope.testScheduler) {
      val stalled = StalledTransport()
      val client = server.registerClient(1, stalled)
      server.broadcast("in-flight")
      runCurrent()
      repeat(WebSocketServer.OUTGOING_CAPACITY) {
        server.broadcast("""{"type":"must_deliver","index":$it}""")
      }
      val response = """{"type":"action_result","requestId":"awaited"}"""
      server.sendToClient(client, response)

      assertEquals(WebSocketServer.OUTGOING_CAPACITY + 1, client.pendingCount)
      assertEquals(1, server.getConnectionCount())
      stalled.unblock()
      runCurrent()
      assertEquals(response, stalled.messages.last())
    }

  @Test
  fun `pending hierarchy updates coalesce in place`() =
    runTest(testScope.testScheduler) {
      val stalled = StalledTransport()
      val client = server.registerClient(1, stalled)
      server.broadcast("in-flight")
      runCurrent()
      val first = """{"type":"hierarchy_update","data":"old"}"""
      val newest = """{"type":"hierarchy_update","data":"new"}"""
      server.broadcast(first)
      server.broadcast("marker")
      server.broadcast(newest)

      assertEquals(1L, client.droppedCount)
      assertEquals(2, client.pendingCount)
      stalled.unblock()
      runCurrent()
      assertEquals(listOf("in-flight", newest, "marker"), stalled.messages)
    }

  @Test
  fun `stalled client is closed at hard ceiling while healthy client receives ordered frames`() =
    runTest(testScope.testScheduler) {
      val stalled = StalledTransport()
      val healthy = RecordingTransport()
      val stalledClient = server.registerClient(1, stalled)
      server.registerClient(2, healthy)
      runCurrent()

      val messages =
        (0..WebSocketServer.OUTGOING_HARD_CEILING + 1).map {
          """{"type":"must_deliver","index":$it}"""
        }
      server.broadcast(messages.first())
      runCurrent() // The stalled sender is now blocked on its first frame.
      messages.drop(1).take(WebSocketServer.OUTGOING_HARD_CEILING).chunked(32).forEach { batch ->
        batch.forEach { server.broadcast(it) }
        runCurrent() // Healthy client drains independently after each short burst.
      }
      // One frame is in flight and exactly the hard ceiling is waiting behind it.
      assertEquals(2, server.getConnectionCount())
      assertNull(stalled.closeReason)

      messages.drop(WebSocketServer.OUTGOING_HARD_CEILING + 1).forEach { server.broadcast(it) }
      runCurrent()

      assertEquals(messages, healthy.messages)
      assertEquals(1, server.getConnectionCount())
      assertTrue(
        stalledClient.outgoing
          .trySend(
            WebSocketServer.OutgoingFrame(
              "after-disconnect",
              WebSocketServer.OutgoingTier.MUST_DELIVER,
            )
          )
          .isFailure
      )
      assertEquals(CloseReason.Codes.TRY_AGAIN_LATER.code, stalled.closeReason?.code)
      assertTrue(stalled.closeReason?.message?.contains("Outgoing buffer full") == true)
    }

  @Test
  fun `sync hierarchy enqueue precedes correlated response for its client`() =
    runTest(testScope.testScheduler) {
      val transport = RecordingTransport()
      val client = server.registerClient(1, transport)
      val hierarchy = """{"type":"hierarchy_update","data":"current"}"""
      val response = """{"type":"action_result","requestId":"awaited"}"""

      server.broadcastWithPerfSync { hierarchy }
      server.sendToClient(client, response)
      runCurrent()

      assertEquals(listOf(hierarchy, response), transport.messages)
    }

  private class StalledTransport : WebSocketServer.ClientTransport {
    var closeReason: CloseReason? = null
    val messages = mutableListOf<String>()
    private val released = CompletableDeferred<Unit>()

    override suspend fun send(message: String) {
      released.await()
      messages.add(message)
    }

    fun unblock() {
      released.complete(Unit)
    }

    override suspend fun close(reason: CloseReason) {
      closeReason = reason
    }
  }

  private class RecordingTransport : WebSocketServer.ClientTransport {
    val messages = mutableListOf<String>()

    override suspend fun send(message: String) {
      messages.add(message)
    }

    override suspend fun close(reason: CloseReason) = Unit
  }

  private fun serverWithHandler(
    handle: suspend (WebSocketRequest) -> WebSocketResponse?
  ): WebSocketServer =
    WebSocketServer(
      port = 0,
      scope = testScope,
      messageHandler =
        object : WebSocketMessageHandler {
          override suspend fun handleMessage(request: WebSocketRequest): WebSocketResponse? =
            handle(request)
        },
    )

  @Test
  fun `successful non-null response clears request owner`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { request ->
        SwipeResult(
          timestamp = 0L,
          requestId = request.requestId,
          success = true,
          totalTimeMs = 1L,
        )
      }
      val owner = server.registerClient(1, RecordingTransport())

      server.handleClientMessage(
        """{"type":"request_screenshot","requestId":"success"}""",
        owner,
      )
      runCurrent()

      assertFalse(server.hasRequestOwner("success"))
    }

  @Test
  fun `handler error clears request owner`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { throw IllegalStateException("expected failure") }
      val owner = server.registerClient(1, RecordingTransport())

      server.handleClientMessage(
        """{"type":"request_screenshot","requestId":"error"}""",
        owner,
      )

      assertFalse(server.hasRequestOwner("error"))
    }

  @Test
  fun `fire and forget commands do not retain request owners`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { null }
      val owner = server.registerClient(1, RecordingTransport())
      val commands =
        listOf(
          """{"type":"set_hierarchy_interval","requestId":"interval"}""",
          """{"type":"set_recomposition_tracking","requestId":"recomposition","enabled":true}""",
          """{"type":"set_accessibility_flags","requestId":"accessibility"}""",
          // set_network_mock_rules is awaited when it carries a requestId (#10101); see
          // `set_network_mock_rules records an owner only when it carries a requestId`.
          """{"type":"set_network_error_simulation","requestId":"network-error","enabled":true}""",
          """{"type":"start_recording","requestId":"record-start"}""",
          """{"type":"stop_recording","requestId":"record-stop"}""",
        )

      commands.forEach { command ->
        server.handleClientMessage(command, owner)
        val requestId = WebSocketServer.extractRequestId(command)!!
        assertFalse("$requestId should not have an owner", server.hasRequestOwner(requestId))
      }
    }

  @Test
  fun `cancelled never completing handler releases request owner`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler {
        kotlinx.coroutines.awaitCancellation()
      }
      val owner = server.registerClient(1, RecordingTransport())
      val handling = launch {
        server.handleClientMessage(
          """{"type":"request_screenshot","requestId":"never-completes"}""",
          owner,
        )
      }
      runCurrent()
      assertTrue(server.hasRequestOwner("never-completes"))

      handling.cancelAndJoin()

      assertFalse(server.hasRequestOwner("never-completes"))
    }

  @Test
  fun `disconnect clears request owners for session`() =
    runTest(testScope.testScheduler) {
      val owner = server.registerClient(1, RecordingTransport())
      server.registerRequestOwner("disconnect", owner)
      assertTrue(server.hasRequestOwner("disconnect"))

      server.unregisterClient(owner)

      assertFalse(server.hasRequestOwner("disconnect"))
    }

  @Test
  fun `parsed log event keeps the exact wire frame for every client`() =
    runTest(testScope.testScheduler) {
      val clients = List(3) { RecordingTransport() }
      clients.forEachIndexed { index, transport -> server.registerClient(index + 1, transport) }
      val buffer = BoundedLogBuffer(capacity = 128, stats = CtrlProxyWorkStats())
      val parser =
        ThreadtimeLogLineParser(
          object : TimeProvider {
            override fun currentTimeMillis(): Long = 42L
          }
        )
      var parses = 0
      val reader =
        LogcatReader(
          onLogEvent = {},
          hasConsumer = { server.getConnectionCount() > 0 },
          tryDeliver = buffer::offer,
          ownPid = { 1234 },
          parser =
            LogLineParser { line ->
              parses++
              parser.parse(line)
            },
        )

      reader.handleLine("04-01 12:34:56.789  4321  5678 I MyApp: hello \"world\"")
      val response = buffer.channel.tryReceive().getOrNull()
      assertTrue(response is dev.jasonpearson.automobile.protocol.LogEventResponse)
      server.broadcast(response!!)
      runCurrent()

      assertEquals(1, parses)
      val expected =
        """{"type":"log_event","timestamp":42,"event":{"level":4,"tag":"MyApp","message":"hello \"world\"","pid":4321,"tid":5678,"applicationId":null}}"""
      clients.forEach { assertEquals(listOf(expected), it.messages) }
      assertNull(buffer.channel.tryReceive().getOrNull())
    }

  // ---------------------------------------------------------------------------
  // Error-envelope helpers (issue #2985) — pure, no network I/O.
  // ---------------------------------------------------------------------------

  @Test
  fun `extractRequestId returns id when present in raw json`() {
    assertEquals(
      "abc-123",
      WebSocketServer.extractRequestId("""{"type":"request_screenshot","requestId":"abc-123"}"""),
    )
  }

  @Test
  fun `extractRequestId returns null when absent`() {
    assertNull(WebSocketServer.extractRequestId("""{"type":"request_screenshot"}"""))
  }

  @Test
  fun `extractRequestId returns null for non-string requestId`() {
    assertNull(WebSocketServer.extractRequestId("""{"type":"x","requestId":42}"""))
  }

  @Test
  fun `extractRequestId returns null for unparseable payload`() {
    assertNull(WebSocketServer.extractRequestId("""{not valid json"""))
  }

  // ---------------------------------------------------------------------------
  // requestId correlation without re-parsing (issue #5462)
  // ---------------------------------------------------------------------------

  @Test
  fun `correlationRequestId reads id off a typed correlated response`() {
    // The typed broadcast path clears requestConnections by this id; reading it off the object
    // (instead of encode->extractRequestId) must yield the same key the entry was recorded under.
    val response =
      SwipeResult(timestamp = 0L, requestId = "req-1", success = true, totalTimeMs = 5L)
    assertEquals("req-1", WebSocketServer.correlationRequestId(response))
  }

  @Test
  fun `correlationRequestId reads keyboard profile result id`() {
    val response = SetKeyboardProfileResult(timestamp = 0L, requestId = "profile-1", success = true)
    assertEquals("profile-1", WebSocketServer.correlationRequestId(response))
  }

  @Test
  fun `correlationRequestId reads id off an error response`() {
    val response = ErrorResponse(requestId = "err-1", error = "boom")
    assertEquals("err-1", WebSocketServer.correlationRequestId(response))
  }

  @Test
  fun `correlationRequestId is null for an uncorrelated hierarchy frame`() {
    val event = HierarchyUpdateEvent(timestamp = 0L, data = "{}")
    assertNull(WebSocketServer.correlationRequestId(event))
  }

  @Test
  fun `correlationRequestId reads correlated hierarchy frame`() {
    val event = HierarchyUpdateEvent(timestamp = 0L, data = "{}", requestId = "hierarchy-1")
    assertEquals("hierarchy-1", WebSocketServer.correlationRequestId(event))
  }

  @Test
  fun `correlated hierarchy broadcast reaches clients without an owner entry`() =
    runTest(testScope.testScheduler) {
      val first = RecordingTransport()
      val second = RecordingTransport()
      server.registerClient(1, first)
      server.registerClient(2, second)
      val frame = """{"type":"hierarchy_update","requestId":"hierarchy-1","data":{}}"""

      server.broadcastWithPerfSync(routeByRequestId = false) { frame }
      runCurrent()

      assertEquals(listOf(frame), first.messages)
      assertEquals(listOf(frame), second.messages)
    }

  @Test
  fun `hierarchy requests record a terminal response owner`() {
    assertTrue(server.recordsRequestOwner(RequestHierarchy(requestId = "req_owner")))
    assertTrue(
      server.recordsRequestOwner(
        RequestHierarchyIfStale(sinceTimestamp = 0L, requestId = "stale_owner")
      )
    )
  }

  // Issue #10101: a rules push that asks for the rejected-rule report keeps an owner so the reply
  // reaches the asking client; the fire-and-forget push must not leak one.
  @Test
  fun `set_network_mock_rules records an owner only when it carries a requestId`() {
    assertTrue(
      server.recordsRequestOwner(SetNetworkMockRules(requestId = "r1", rules = emptyList()))
    )
    assertFalse(server.recordsRequestOwner(SetNetworkMockRules(rules = emptyList())))
  }

  @Test
  fun `the rules result is routed by its requestId`() {
    assertEquals(
      "r1",
      WebSocketServer.correlationRequestId(
        SetNetworkMockRulesResult(timestamp = 1L, requestId = "r1")
      ),
    )
  }

  @Test
  fun `unowned stale error is dropped unless externally correlated`() =
    runTest(testScope.testScheduler) {
      val first = RecordingTransport()
      val second = RecordingTransport()
      server.registerClient(1, first)
      server.registerClient(2, second)
      val frame =
        HierarchyExtractErrorFrames.thrownFrame(
          "stale_unowned",
          IllegalStateException("tree failed"),
        )!!

      server.broadcast(frame)
      runCurrent()
      assertTrue(first.messages.isEmpty())
      assertTrue(second.messages.isEmpty())

      server.broadcastExternallyCorrelatedResponse(frame)
      runCurrent()
      assertEquals(1, first.messages.size)
      assertEquals(first.messages, second.messages)
      assertEquals("stale_unowned", WebSocketServer.extractRequestId(first.messages.single()))
    }

  @Test
  fun `unsolicited hierarchy still reaches every client`() =
    runTest(testScope.testScheduler) {
      val first = RecordingTransport()
      val second = RecordingTransport()
      server.registerClient(1, first)
      server.registerClient(2, second)
      val frame = """{"type":"hierarchy_update","data":{}}"""

      server.broadcastWithPerfSync { frame }
      runCurrent()

      assertEquals(listOf(frame), first.messages)
      assertEquals(listOf(frame), second.messages)
    }

  @Test
  fun `correlated response is queued only for its request owner`() =
    runTest(testScope.testScheduler) {
      val ownerTransport = RecordingTransport()
      val bystanderTransport = RecordingTransport()
      val owner = server.registerClient(1, ownerTransport)
      server.registerClient(2, bystanderTransport)
      server.registerRequestOwner("req-failed", owner)

      server.broadcast(
        SwipeResult(timestamp = 0L, requestId = "req-failed", success = true, totalTimeMs = 5L)
      )
      runCurrent()

      assertEquals(1, ownerTransport.messages.size)
      assertEquals("req-failed", WebSocketServer.extractRequestId(ownerTransport.messages.single()))
      assertTrue(bystanderTransport.messages.isEmpty())
      server.broadcast(ErrorResponse(requestId = "req-failed", error = "duplicate fallback"))
      runCurrent()
      assertEquals(1, ownerTransport.messages.size)
      assertTrue(bystanderTransport.messages.isEmpty())
    }

  @Test
  fun `guard fallback routes to the owner when result creation fails before delivery`() =
    runTest(testScope.testScheduler) {
      val ownerTransport = RecordingTransport()
      val bystanderTransport = RecordingTransport()
      val owner = server.registerClient(1, ownerTransport)
      server.registerClient(2, bystanderTransport)
      server.registerRequestOwner("req-guard", owner)
      val broadcaster =
        ResultBroadcaster(broadcastError = { server.broadcast(it) }, logError = { _, _ -> })

      broadcaster.guard(requestId = "req-guard", action = "swipe_result") {
        throw IllegalStateException("result serialization failed")
      }
      runCurrent()

      assertEquals(1, ownerTransport.messages.size)
      assertEquals("req-guard", WebSocketServer.extractRequestId(ownerTransport.messages.single()))
      assertTrue(ownerTransport.messages.single().contains("result serialization failed"))
      assertTrue(bystanderTransport.messages.isEmpty())
    }

  @Test
  fun `duplicate correlated frame is dropped after successful delivery`() =
    runTest(testScope.testScheduler) {
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      server.registerRequestOwner("req-done", owner)

      server.broadcast("""{"type":"result","requestId":"req-done"}""")
      server.broadcast(ErrorResponse(requestId = "req-done", error = "duplicate"))
      runCurrent()

      assertEquals(listOf("""{"type":"result","requestId":"req-done"}"""), transport.messages)
    }

  @Test
  fun `reused request id during delivery reaches its new owner`() =
    runTest(testScope.testScheduler) {
      val firstTransport = RecordingTransport()
      val nextTransport = RecordingTransport()
      var first = true
      lateinit var nextOwner: WebSocketServer.ConnectedClient
      val firstResponse = """{"type":"result","requestId":"reused","owner":"first"}"""
      val nextResponse = """{"type":"result","requestId":"reused","owner":"next"}"""
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          onCorrelatedRoutingStep = {
            if (first) {
              first = false
              server.registerRequestOwner("reused", nextOwner)
              server.routeCorrelatedResponse("reused", nextResponse)
            }
          },
        )
      val firstOwner = server.registerClient(1, firstTransport)
      nextOwner = server.registerClient(2, nextTransport)
      server.registerRequestOwner("reused", firstOwner)

      server.routeCorrelatedResponse("reused", firstResponse)
      runCurrent()

      assertEquals(listOf(firstResponse), firstTransport.messages)
      assertEquals(listOf(nextResponse), nextTransport.messages)
    }

  @Test
  fun `unknown and expired correlated frames are dropped`() =
    runTest(testScope.testScheduler) {
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)

      server.broadcast(ErrorResponse(requestId = "never-registered", error = "unknown"))
      runCurrent()
      assertTrue(transport.messages.isEmpty())
      server.registerRequestOwner("expired", owner)
      server.broadcast("""{"type":"result","requestId":"expired"}""")
      runCurrent()
      transport.messages.clear()
      server.broadcast(ErrorResponse(requestId = "expired", error = "late"))
      runCurrent()

      assertTrue(transport.messages.isEmpty())
    }

  @Test
  fun `mightCarryRequestId short-circuits frames without the requestId token`() {
    // hierarchy_update is the hot, large frame and never carries a requestId; the gate must return
    // false so extractRequestId skips parseToJsonElement entirely.
    val hierarchyFrame =
      """{"type":"hierarchy_update","timestamp":1,"data":"<hierarchy>...</hierarchy>"}"""
    assertFalse(WebSocketServer.mightCarryRequestId(hierarchyFrame))
    assertNull(WebSocketServer.extractRequestId(hierarchyFrame))
  }

  @Test
  fun `mightCarryRequestId detects the requestId token`() {
    assertTrue(
      WebSocketServer.mightCarryRequestId("""{"type":"request_screenshot","requestId":"abc-123"}""")
    )
  }

  @Test
  fun `extractRequestId does not parse a substring-free payload`() {
    // No `"requestId"` token but otherwise unparseable: proves the parser is never reached, since
    // the gate returns false before parseToJsonElement would run.
    val payload = "<<< not json and carries no token >>>"
    assertFalse(WebSocketServer.mightCarryRequestId(payload))
    assertNull(WebSocketServer.extractRequestId(payload))
  }

  @Test
  fun `describeDecodeFailure surfaces unknown command type`() {
    val message =
      WebSocketServer.describeDecodeFailure(
        """{"type":"totally_unknown_command","requestId":"r1"}""",
        kotlinx.serialization.SerializationException(
          "Serializer for subclass 'totally_unknown_command' is not found in the polymorphic scope of 'WebSocketRequest'."
        ),
      )
    assertTrue(
      "expected message to name the unknown type, was: $message",
      message.contains("totally_unknown_command"),
    )
  }

  @Test
  fun `describeDecodeFailure returns non-empty message for malformed json`() {
    val message =
      WebSocketServer.describeDecodeFailure(
        """{"type":"request_screenshot",""",
        kotlinx.serialization.SerializationException("Unexpected end of input"),
      )
    assertTrue("expected non-empty message", message.isNotEmpty())
  }

  @Test
  fun `server can be created with custom port`() =
    runTest(testScope.testScheduler) {
      // Given
      val customPort = 9999
      val customServer = WebSocketServer(port = customPort, scope = testScope)

      // When
      customServer.start()
      runCurrent()

      // Then
      assertTrue("Custom server should be running", customServer.isRunning())

      // Cleanup
      customServer.stop()
    }

  @Test
  fun `known overlay nested decode failures return correlated overlay results`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { error("Malformed payload must never dispatch") }
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      val cases =
        listOf(
          "root" to
            """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"unknown_node"}}""",
          "onTap" to
            """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi","onTap":[{"type":"unknown_action"}]}}""",
          "placement" to
            """{"id":"panel","window":{"placement":{"type":"unknown_placement"}},"root":{"type":"text","text":"Hi"}}""",
          "root" to
            """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"text":"Missing type"}}""",
        )
      for (command in listOf("show_overlay", "update_overlay")) {
        for ((index, case) in cases.withIndex()) {
          val (field, spec) = case
          val requestId = "$command-$index"
          val raw = """{"type":"$command","requestId":"$requestId","id":"panel","spec":$spec}"""
          server.handleClientMessage(raw, owner)
          runCurrent()
          val response = Json.decodeFromString<WebSocketResponse>(transport.messages.last())
          assertTrue("Expected overlay_result: $response", response is OverlayResult)
          val result = response as OverlayResult
          assertEquals(requestId, result.requestId)
          assertFalse(result.success)
          assertTrue(
            "Expected field $field: ${result.error}",
            result.error?.contains(field) == true,
          )
          assertTrue(result.error?.startsWith("Malformed request:") == true)
        }
      }
    }

  @Test
  fun `malformed overlay asset requests get one correlated overlay result and no echoed bytes`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { error("Malformed payload must never dispatch") }
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      val bytes = "SECRETBYTES".repeat(8)
      val cases =
        listOf(
          """{"type":"put_overlay_asset","requestId":"put-bad","id":"hero","mimeType":"image/png","dataBase64":{}}""",
          """{"type":"put_overlay_asset","requestId":"put-missing","mimeType":"image/png","dataBase64":"$bytes"}""",
          """{"type":"remove_overlay_asset","requestId":"remove-bad","id":7}""",
        )
      for (raw in cases) {
        val before = transport.messages.size
        server.handleClientMessage(raw, owner)
        runCurrent()
        assertEquals(before + 1, transport.messages.size)
        val result =
          Json.decodeFromString<WebSocketResponse>(transport.messages.last()) as OverlayResult
        assertEquals(
          Regex("\"requestId\":\"([^\"]+)\"").find(raw)!!.groupValues[1],
          result.requestId,
        )
        assertFalse(result.success)
        assertTrue(result.error.orEmpty().startsWith("Malformed request:"))
        assertFalse(result.error.orEmpty().contains("SECRETBYTES"))
      }
    }

  @Test
  fun `an asset frame above its type's cap is answered without being deserialized`() =
    runTest(testScope.testScheduler) {
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          messageHandler =
            object : WebSocketMessageHandler {
              override suspend fun handleMessage(request: WebSocketRequest): WebSocketResponse? =
                error("An oversized frame must never dispatch")
            },
          inboundFrameLimits = InboundFrameLimits(mapOf("put_overlay_asset" to 128L)),
        )
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      // `dataBase64` is not a string, so a full decode would fail with "Malformed request:"; the
      // cap reply proves the frame was never deserialized.
      val raw =
        """{"requestId":"put-big","id":"hero","mimeType":"image/png","dataBase64":["${"SECRETBYTES".repeat(16)}"],"type":"put_overlay_asset"}"""
      server.handleInboundTextFrame(1, Frame.Text(raw), owner)
      runCurrent()
      val reply = transport.messages.single()
      assertFalse(reply, reply.contains("SECRETBYTES"))
      val result = Json.decodeFromString<WebSocketResponse>(reply) as OverlayResult
      assertEquals("put-big", result.requestId)
      assertFalse(result.success)
      assertEquals(
        "Request frame for put_overlay_asset is ${raw.encodeToByteArray().size} bytes; " +
          "the limit is 128 bytes.",
        result.error,
      )
    }

  @Test
  fun `a frame within its type's cap is decoded and dispatched`() =
    runTest(testScope.testScheduler) {
      val received = mutableListOf<WebSocketRequest>()
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          messageHandler =
            object : WebSocketMessageHandler {
              override suspend fun handleMessage(request: WebSocketRequest): WebSocketResponse? {
                received += request
                return null
              }
            },
          inboundFrameLimits = InboundFrameLimits(mapOf("put_overlay_asset" to 16L)),
        )
      val owner = server.registerClient(1, RecordingTransport())
      // Above the smallest cap but of an uncapped type, so it decodes as before.
      server.handleInboundTextFrame(
        1,
        Frame.Text("""{"type":"request_hierarchy","requestId":"h1"}"""),
        owner,
      )
      advanceUntilIdle()
      assertEquals(listOf<WebSocketRequest>(RequestHierarchy(requestId = "h1")), received)
    }

  @Test
  fun `a syntax error next to asset bytes does not echo them in the error reply`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { error("Malformed payload must never dispatch") }
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      val bytes = "SECRETBYTES".repeat(8)
      // The parser fails right after the data, so its input snippet is made of the data. The
      // frame is not valid JSON, so its type is unreadable and the reply is a generic error.
      val raw =
        """{"type":"put_overlay_asset","requestId":"put-adjacent","id":"hero","mimeType":"image/png","dataBase64":"$bytes" "x"}"""
      server.handleClientMessage(raw, owner)
      runCurrent()
      assertEquals(1, transport.messages.size)
      val reply = transport.messages.single()
      assertFalse(reply, reply.contains("SECRETBYTES"))
      assertTrue(reply, reply.contains("Malformed request:"))
      assertTrue("diagnosis is kept: $reply", reply.contains("offset"))
    }

  @Test
  fun `a well formed asset frame that fails decoding next to the data echoes no bytes`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { error("Malformed payload must never dispatch") }
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      val bytes = "SECRETBYTES".repeat(8)
      server.handleClientMessage(
        """{"type":"put_overlay_asset","requestId":"adj","dataBase64":"$bytes","mimeType":["image/png"],"id":"hero"}""",
        owner,
      )
      runCurrent()
      assertEquals(1, transport.messages.size)
      val reply = transport.messages.single()
      assertFalse(reply, reply.contains("SECRETBYTES"))
      assertTrue(Json.decodeFromString<WebSocketResponse>(reply) is OverlayResult)
    }

  @Test
  fun `a truncated asset frame whose type cannot be parsed still echoes no bytes`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { error("Malformed payload must never dispatch") }
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      val bytes = "SECRETBYTES".repeat(8)
      server.handleClientMessage(
        """{"type":"put_overlay_asset","requestId":"cut","id":"hero","dataBase64":"$bytes""",
        owner,
      )
      runCurrent()
      assertEquals(1, transport.messages.size)
      assertFalse(transport.messages.single().contains("SECRETBYTES"))
    }

  @Test
  fun `describeDecodeFailure drops the parser input snippet for asset frames only`() {
    val snippet = "JSON input: ...SECRETBYTES..."
    val failure = IllegalArgumentException("Unexpected JSON token at offset 40: bad\n$snippet")
    val asset = """{"type":"put_overlay_asset","dataBase64":"SECRETBYTES"}"""
    assertEquals(
      "Malformed request: Unexpected JSON token at offset 40: bad",
      WebSocketServer.describeDecodeFailure(asset, failure),
    )
    val other = """{"type":"show_overlay","x":"oops"}"""
    assertTrue(WebSocketServer.describeDecodeFailure(other, failure).contains("SECRETBYTES"))
  }

  @Test
  fun `asset requests are advertised so older devices can be detected by absence`() {
    val commands = WebSocketServer(port = 0, scope = testScope).supportedCommands()
    assertTrue(commands.contains("put_overlay_asset"))
    assertTrue(commands.contains("remove_overlay_asset"))
    assertTrue(commands.contains("full_command_set_v1"))
  }

  @Test
  fun `dismiss payload failure is an overlay result while other known commands keep error frames`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { error("Malformed payload must never dispatch") }
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      server.handleClientMessage(
        """{"type":"dismiss_overlay","requestId":"dismiss-bad","all":{}}""",
        owner,
      )
      runCurrent()
      val overlay =
        Json.decodeFromString<WebSocketResponse>(transport.messages.last()) as OverlayResult
      assertEquals("dismiss-bad", overlay.requestId)
      assertFalse(overlay.success)
      assertTrue(overlay.error?.contains("all") == true)
      server.handleClientMessage(
        """{"type":"request_screenshot","requestId":"known-bad","displayId":{}}""",
        owner,
      )
      runCurrent()
      val known =
        Json.decodeFromString<WebSocketResponse>(transport.messages.last()) as ErrorResponse
      assertEquals("known-bad", known.requestId)
      assertTrue(known.error.startsWith("Malformed request:"))
      server.handleClientMessage("""{"type":"truly_unknown","requestId":"unknown"}""", owner)
      runCurrent()
      val unknown =
        Json.decodeFromString<WebSocketResponse>(transport.messages.last()) as ErrorResponse
      assertEquals("unknown", unknown.requestId)
      assertEquals("Unknown command type: truly_unknown", unknown.error)
    }

  @Test
  fun `overlay results correlate while overlay events do not`() {
    assertEquals(
      "overlay-r",
      WebSocketServer.correlationRequestId(
        OverlayResult(timestamp = 0L, requestId = "overlay-r", success = false)
      ),
    )
    assertNull(
      WebSocketServer.correlationRequestId(
        OverlayEvent(
          timestamp = 0L,
          id = "panel",
          sequence = 1L,
          kind = OverlayEventKind.DISMISSED,
          name = null,
          payload = null,
          state = emptyMap(),
        )
      )
    )
  }
}
