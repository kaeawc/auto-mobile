package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.WebSocketServerIntegrationTestFixtures.Companion.FRAME_TIMEOUT_MS
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.get
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Real socket startup, reconnection, health, and continuous observer sessions. */
@RunWith(RobolectricTestRunner::class)
internal class WebSocketServerIntegrationTestLifecycleTest :
  WebSocketServerIntegrationTestFixtures() {

  @Test
  fun `server starts and stops successfully`() = runBlocking {
    // When
    startAndWait(server)

    // Then
    assertTrue("Server should be running", server.isRunning())

    // When - stop server
    server.stop()

    // Then
    assertFalse("Server should be stopped", server.isRunning())
  }

  @Test
  fun `broadcast after stop and restart reaches a client once`() = runBlocking {
    startAndWait(server)
    server.stop()
    startAndWait(server)

    val client = HttpClient(CIO) { install(WebSockets) }
    client.use { c ->
      c.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        incoming.receive() // Connection message
        awaitClientsRegistered(server, 1)
        server.broadcast("""{"type":"probe","sequence":1}""")
        val first = (withTimeout(FRAME_TIMEOUT_MS) { incoming.receive() } as Frame.Text).readText()
        server.broadcast("""{"type":"probe","sequence":2}""")
        val second = (withTimeout(FRAME_TIMEOUT_MS) { incoming.receive() } as Frame.Text).readText()

        assertEquals("""{"type":"probe","sequence":1}""", first)
        assertEquals(
          "Second frame must be the second broadcast",
          """{"type":"probe","sequence":2}""",
          second,
        )
      }
    }
  }

  @Test
  fun `server does not start twice`() = runBlocking {
    // Given
    startAndWait(server)

    // When - try to start again
    startAndWait(server)

    // Then - should still be running normally
    assertTrue("Server should still be running", server.isRunning())
  }

  @Test
  fun `client can connect to server`() = runBlocking {
    // Given
    startAndWait(server)
    val firstClientConnection = async { server.awaitFirstClientConnection() }

    assertFalse("No client should be ready before the handshake", firstClientConnection.isCompleted)

    // When
    val client = HttpClient(CIO) { install(WebSockets) }

    client.use { client ->
      client.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        // Then - connection established
        waitFor { server.getConnectionCount() == 1 }
        withTimeout(1000) { firstClientConnection.await() }
        assertEquals(1, server.getConnectionCount())

        // Receive connection message
        val frame = withTimeout(1000) { incoming.receive() }
        if (frame is Frame.Text) {
          val message = frame.readText()
          assertTrue("Should receive connection message", message.contains("connected"))
          val supportedCommands =
            json
              .parseToJsonElement(message)
              .jsonObject["supportedCommands"]
              ?.jsonArray
              ?.map { it.jsonPrimitive.content }
              .orEmpty()
          assertTrue(
            "Should advertise optional discover_keystore",
            supportedCommands.contains("discover_keystore"),
          )
          assertTrue(
            "Should advertise request_insert_text",
            supportedCommands.contains("request_insert_text"),
          )
          assertTrue(
            "Should advertise gesture display routing",
            supportedCommands.contains("gesture_display_id_v1"),
          )
          assertTrue(
            "Should advertise request ID echo",
            supportedCommands.contains("request_id_echo_v1"),
          )
          assertFalse(
            "Should not advertise iOS-only request_press_key",
            supportedCommands.contains("request_press_key"),
          )
        }
      }
    }

    // Wait for cleanup using condition-based waiting
    waitFor { server.getConnectionCount() == 0 }
    assertEquals("Connection should be cleaned up", 0, server.getConnectionCount())
  }

  @Test
  fun `observerSessionGeneration is stable within a session and advances after it empties`() =
    runBlocking {
      // The scroll-staleness fix (issue #5470) keys "is this the same observer session" on
      // observerSessionGeneration, which must advance ONLY on the empty->non-empty edge:
      //  - stable while >= 1 client stays continuously connected (so a concurrent 2nd client
      // joining
      //    does NOT reset a still-connected client's in-flight scroll),
      //  - advanced after the set empties and a new client connects (so a disconnect+reconnect,
      //    including one with no intervening event, correctly clears stale scroll deltas).
      startAndWait(server)
      assertEquals(
        "generation starts at 0 before any connection",
        0,
        server.observerSessionGeneration(),
      )

      assertContinuousObserverSession()
      assertReconnectedObserverSession()
    }

  private suspend fun assertContinuousObserverSession() {
    val client1 = HttpClient(CIO) { install(WebSockets) }
    val client2 = HttpClient(CIO) { install(WebSockets) }
    client1.use { c1 ->
      c1.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        waitFor { server.getConnectionCount() == 1 }
        val genAfterFirst = server.observerSessionGeneration()
        assertEquals("generation advances on the first client of a session", 1, genAfterFirst)

        // A SECOND concurrent client joins (1 -> 2): the generation must NOT change.
        client2.use { c2 ->
          c2.webSocket(
            method = HttpMethod.Get,
            host = "localhost",
            port = getServerPort(),
            path = "/ws",
          ) {
            waitFor { server.getConnectionCount() == 2 }
            assertEquals(
              "a concurrent 2nd client must not change the generation",
              genAfterFirst,
              server.observerSessionGeneration(),
            )
          }
        }
        // Second client gone; first still connected — still the same session.
        waitFor { server.getConnectionCount() == 1 }
        assertEquals(
          "generation is stable while a client stays connected",
          genAfterFirst,
          server.observerSessionGeneration(),
        )
      }
    }
  }

  private suspend fun assertReconnectedObserverSession() {
    // The set has now emptied. A new client starts a new session: generation must advance.
    waitFor { server.getConnectionCount() == 0 }
    val genAfterEmpty = server.observerSessionGeneration()
    val client3 = HttpClient(CIO) { install(WebSockets) }
    client3.use { c3 ->
      c3.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        waitFor { server.getConnectionCount() == 1 }
        assertEquals(
          "live count cannot distinguish the reconnect",
          1,
          server.getConnectionCount(),
        )
        assertTrue(
          "generation must advance after the set empties (was $genAfterEmpty, now ${server.observerSessionGeneration()})",
          server.observerSessionGeneration() > genAfterEmpty,
        )
      }
    }
    waitFor { server.getConnectionCount() == 0 }
  }

  @Test
  fun `health check endpoint responds correctly`() = runBlocking {
    // Given
    startAndWait(server)

    // When
    val client = HttpClient(CIO)
    client.use { client ->
      val response = client.get("http://localhost:${getServerPort()}/health")

      // Then
      assertEquals("Health check should return OK", HttpStatusCode.OK, response.status)
    }
  }

  @Test
  fun `server handles client disconnection gracefully`() = runBlocking {
    // Given
    startAndWait(server)

    val client = HttpClient(CIO) { install(WebSockets) }

    client.use { client ->
      val job = launch {
        client.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = getServerPort(),
          path = "/ws",
        ) {
          incoming.receive() // Connection message
          // Hold the connection open until the test cancels the job. A session that ended on
          // its own after a short delay could close before the server-side count was observed
          // at 1, timing out the first waitFor on a slow runner.
          awaitCancellation()
        }
      }

      waitFor { server.getConnectionCount() == 1 }
      assertEquals("Should have 1 connection", 1, server.getConnectionCount())

      // When - client disconnects
      job.cancel()
      waitFor { server.getConnectionCount() == 0 }

      // Then - connection should be cleaned up
      assertEquals("Connection should be cleaned up", 0, server.getConnectionCount())
    }
  }

  @Test
  fun `await client connection waits for a replacement client after disconnect`() = runBlocking {
    startAndWait(server)

    val client = HttpClient(CIO) { install(WebSockets) }
    client.use { client ->
      val firstClient = launch {
        client.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = getServerPort(),
          path = "/ws",
        ) {
          incoming.receive()
          delay(Long.MAX_VALUE)
        }
      }

      waitFor { server.getConnectionCount() == 1 }
      withTimeout(CONNECTION_WAIT_MS) { server.awaitClientConnection() }

      firstClient.cancel()
      firstClient.join()
      waitFor { server.getConnectionCount() == 0 }

      val reconnectWait = async { server.awaitClientConnection() }
      assertFalse(
        "A disconnected client must not satisfy the delivery gate",
        reconnectWait.isCompleted,
      )

      val replacementClient = launch {
        client.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = getServerPort(),
          path = "/ws",
        ) {
          incoming.receive()
          delay(Long.MAX_VALUE)
        }
      }

      waitFor { server.getConnectionCount() == 1 }
      withTimeout(CONNECTION_WAIT_MS) { reconnectWait.await() }

      replacementClient.cancel()
      replacementClient.join()
    }
  }

  private companion object {
    // Real loopback sockets on a runner that is also running the rest of the control-proxy suite:
    // the old 1 s ceiling expired under load (TimeoutCancellationException) while the test passed
    // alone. It bounds a hang, not the expected time, so a generous value costs nothing.
    const val CONNECTION_WAIT_MS = 15_000L
  }
}
