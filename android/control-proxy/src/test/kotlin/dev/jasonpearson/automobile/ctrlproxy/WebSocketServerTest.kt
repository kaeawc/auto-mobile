package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.HierarchyUpdateEvent
import dev.jasonpearson.automobile.protocol.SwipeResult
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
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
  fun `server starts successfully`() = runTest {
    // Given
    assertFalse("Server should not be running initially", server.isRunning())

    // When
    server.start()

    // Then
    assertTrue("Server should be running", server.isRunning())
    assertEquals("Should have no connections initially", 0, server.getConnectionCount())
  }

  @Test
  fun `server stops successfully`() = runTest {
    // Given
    server.start()
    assertTrue(server.isRunning())

    // When
    server.stop()

    // Then
    assertFalse("Server should be stopped", server.isRunning())
  }

  @Test
  fun `server does not start twice`() = runTest {
    // Given
    server.start()

    // When - try to start again
    server.start()

    // Then - should still be running normally
    assertTrue("Server should still be running", server.isRunning())
  }

  @Test
  fun `server connection count starts at zero`() = runTest {
    // Given
    server.start()

    // Then
    assertEquals("Connection count should start at 0", 0, server.getConnectionCount())
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
  fun `server can be created with custom port`() = runTest {
    // Given
    val customPort = 9999
    val customServer = WebSocketServer(port = customPort, scope = testScope)

    // When
    customServer.start()

    // Then
    assertTrue("Custom server should be running", customServer.isRunning())

    // Cleanup
    customServer.stop()
  }
}
