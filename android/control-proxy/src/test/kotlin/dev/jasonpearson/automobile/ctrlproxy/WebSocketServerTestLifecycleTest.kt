package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Server startup, bounded bind retries, shutdown, capabilities, and observer generations. */
@RunWith(RobolectricTestRunner::class)
internal class WebSocketServerTestLifecycleTest : WebSocketServerTestFixtures() {

  @Test
  fun `disconnect count captures zero edge before reconnect and carries old observer generation`() =
    runTest {
      val changes = mutableListOf<Pair<Int, Int>>()
      var reconnected: WebSocketServer.ConnectedClient? = null
      server =
        WebSocketServer(
          port = 0,
          scope = this,
          options =
            WebSocketServerOptions(
              onClientDisconnected = { client ->
                if (client.id == 2) reconnected = server.registerClient(3, RecordingTransport())
              },
              onClientCountChanged = { count, session -> changes += count to session },
            ),
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
        WebSocketServer(
            port = 0,
            scope = testScope,
            options = WebSocketServerOptions(sdkInt = { sdk }),
          )
          .supportedCommands()
      assertEquals(
        "Gesture display capability on API $sdk",
        sdk >= 30,
        commands.contains("gesture_display_id_v1"),
      )
      assertTrue(commands.contains("request_insert_text"))
      assertTrue(commands.contains("discover_keystore"))
      assertTrue(commands.contains("get_sdk_capabilities"))
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
          options =
            WebSocketServerOptions(
              onPermanentStartFailure = { permanentFailures++ },
              portAvailable = { available },
            ),
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
          options =
            WebSocketServerOptions(
              portAvailable = {
                probes++
                false
              },
            ),
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
          options =
            WebSocketServerOptions(
              onPermanentStartFailure = { permanentFailures++ },
              portAvailable = { false },
            ),
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
          options =
            WebSocketServerOptions(
              onPermanentStartFailure = { permanentFailures++ },
              portAvailable = { available },
            ),
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
          options =
            WebSocketServerOptions(
              onPermanentStartFailure = { permanentFailures++ },
              portAvailable = { false },
            ),
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
          options =
            WebSocketServerOptions(
              portAvailable = { available },
              onRetryLockAcquired = {
                available = true
                server.stop()
              },
            ),
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
}
