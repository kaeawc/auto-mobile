package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.protocol.SettingsGetResult
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.get
import io.ktor.http.HttpMethod
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Real socket broadcasts, hierarchy encoding, and waiting for an observer. */
@RunWith(RobolectricTestRunner::class)
internal class WebSocketServerIntegrationTestBroadcastTest :
  WebSocketServerIntegrationTestFixtures() {

  @Test
  fun `server broadcasts messages to connected client`() = runBlocking {
    // Given
    startAndWait(server)

    val receivedMessages = mutableListOf<String>()
    val client = HttpClient(CIO) { install(WebSockets) }

    client.use { client ->
      val job = launch {
        client.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = getServerPort(),
          path = "/ws",
        ) {
          // Receive and discard connection message
          incoming.receive()

          // Listen for broadcast messages with timeout
          var messageCount = 0
          for (frame in incoming) {
            if (frame is Frame.Text) {
              receivedMessages.add(frame.readText())
              messageCount++
              break
            }
          }
        }
      }

      // Wait for connection
      waitFor { server.getConnectionCount() == 1 }

      // When - broadcast a message
      val testMessage = """{"type":"test","data":"Hello WebSocket"}"""
      server.broadcast(testMessage)

      // Wait for message to be received
      waitFor { receivedMessages.size >= 1 }

      // Then
      assertEquals("Should receive 1 broadcast message", 1, receivedMessages.size)
      assertEquals(testMessage, receivedMessages[0])

      job.cancel()
    }
  }

  @Test
  fun `server broadcasts hierarchy updates with correct format`() = runBlocking {
    // Given
    startAndWait(server)

    val receivedMessages = mutableListOf<String>()
    val client = HttpClient(CIO) { install(WebSockets) }

    client.use { client ->
      val job = launch {
        client.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = getServerPort(),
          path = "/ws",
        ) {
          incoming.receive() // Discard connection message
          var messageCount = 0
          for (frame in incoming) {
            if (frame is Frame.Text) {
              receivedMessages.add(frame.readText())
              messageCount++
              break
            }
          }
        }
      }

      // Wait for connection
      waitFor { server.getConnectionCount() == 1 }

      // When - create and broadcast a hierarchy update
      val hierarchy =
        ViewHierarchy(
          packageName = "com.example.app",
          hierarchy =
            UIElementInfo(
              text = "Hello",
              clickable = "true",
              bounds = ElementBounds(0, 0, 100, 50),
            ),
        )

      val hierarchyJson = json.encodeToString(ViewHierarchy.serializer(), hierarchy)
      val message =
        """{"type":"hierarchy_update","timestamp":${System.currentTimeMillis()},"data":$hierarchyJson}"""
      server.broadcast(message)

      // Wait for message to be received
      waitFor { receivedMessages.isNotEmpty() }

      // Then - verify message format
      assertEquals("Should receive 1 message", 1, receivedMessages.size)

      val receivedMessage = receivedMessages[0]
      val messageJson = json.parseToJsonElement(receivedMessage).jsonObject

      assertEquals("hierarchy_update", messageJson["type"]?.jsonPrimitive?.content)
      assertNotNull("Should have timestamp", messageJson["timestamp"])
      assertNotNull("Should have data", messageJson["data"])

      // Verify the data contains the hierarchy
      val dataJson = messageJson["data"]?.jsonObject
      assertEquals("com.example.app", dataJson?.get("packageName")?.jsonPrimitive?.content)

      job.cancel()
    }
  }

  @Test
  fun `sync broadcast waits for a client and delivers after it connects`() = runBlocking {
    startAndWait(server)
    val response =
      SettingsGetResult(
        timestamp = 1234L,
        success = true,
        namespace = "secure",
        key = "setting",
        value = "value",
        found = true,
        totalTimeMs = 1L,
      )
    val delivery = async {
      server.broadcast(
        response,
        mode = WebSocketServer.BroadcastMode.Sync,
        waitForClient = true,
      )
    }
    assertFalse("Delivery must wait until a client is connected", delivery.isCompleted)

    val client = HttpClient(CIO) { install(WebSockets) }
    client.use { client ->
      client.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        incoming.receive()
        // This is a real CIO socket round-trip. Shared Linux runners can pause
        // the client and server for over a second while other Gradle test forks
        // run, even though the delivery itself remains correct.
        val delivered = withTimeout(5000) { incoming.receive() } as Frame.Text
        val payload = json.parseToJsonElement(delivered.readText()).jsonObject

        assertEquals("settings_get_result", payload["type"]?.jsonPrimitive?.content)
        withTimeout(5000) { delivery.await() }
      }
    }
  }
}
