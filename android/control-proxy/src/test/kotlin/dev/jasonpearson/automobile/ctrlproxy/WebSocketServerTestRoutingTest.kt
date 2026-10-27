package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.HierarchyUpdateEvent
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.RequestHierarchyIfStale
import dev.jasonpearson.automobile.protocol.SetKeyboardProfileResult
import dev.jasonpearson.automobile.protocol.SetNetworkMockRules
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult
import dev.jasonpearson.automobile.protocol.SwipeResult
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Request ownership, correlated delivery, error envelopes, and private logging. */
@RunWith(RobolectricTestRunner::class)
internal class WebSocketServerTestRoutingTest : WebSocketServerTestFixtures() {

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
      WebSocketServer.textInputParseFailureLogLine(frame, "request_tap_coordinates", error),
    )
  }

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
          },
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
        RequestHierarchyIfStale(sinceTimestamp = 0L, requestId = "stale_owner"),
      ),
    )
  }

  // Issue #10101: a rules push that asks for the rejected-rule report keeps an owner so the reply
  // reaches the asking client; the fire-and-forget push must not leak one.
  @Test
  fun `set_network_mock_rules records an owner only when it carries a requestId`() {
    assertTrue(
      server.recordsRequestOwner(SetNetworkMockRules(requestId = "r1", rules = emptyList())),
    )
    assertFalse(server.recordsRequestOwner(SetNetworkMockRules(rules = emptyList())))
  }

  @Test
  fun `the rules result is routed by its requestId`() {
    assertEquals(
      "r1",
      WebSocketServer.correlationRequestId(
        SetNetworkMockRulesResult(timestamp = 1L, requestId = "r1"),
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
        SwipeResult(timestamp = 0L, requestId = "req-failed", success = true, totalTimeMs = 5L),
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
          options =
            WebSocketServerOptions(
              onCorrelatedRoutingStep = {
                if (first) {
                  first = false
                  server.registerRequestOwner("reused", nextOwner)
                  server.routeCorrelatedResponse("reused", nextResponse)
                }
              },
            ),
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
      WebSocketServer.mightCarryRequestId(
        """{"type":"request_screenshot","requestId":"abc-123"}""",
      ),
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
          "Serializer for subclass 'totally_unknown_command' is not found in the polymorphic scope of 'WebSocketRequest'.",
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
}
