package dev.jasonpearson.automobile.desktop.core.daemon

import java.nio.channels.ClosedByInterruptException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.serialization.json.jsonPrimitive

class OneShotSocketRequestTest {

  @Test
  fun `failures notifications poll sends the current session`() {
    assertFailuresSession("poll_notifications") {
      it.pollNotifications(FailuresNotificationsRequest())
    }
  }

  @Test
  fun `failures groups poll sends the current session`() {
    assertFailuresSession("poll_groups") { it.pollGroups(FailuresGroupsRequest()) }
  }

  @Test
  fun `failures timeline poll sends the current session`() {
    assertFailuresSession("poll_timeline") { it.pollTimeline(FailuresTimelineRequest()) }
  }

  @Test
  fun `failures acknowledge sends the current session`() {
    assertFailuresSession("acknowledge") { it.acknowledge(listOf(7)) }
  }

  private fun assertFailuresSession(
    command: String,
    operation: (FailuresStreamSocketClient) -> Unit,
  ) {
    var sessionUuid = "old-session"
    TestConfigSocketServer(responseType = "unused", rawBodyJson = """{"acknowledgedCount":1}""")
      .use { server ->
        val client =
          FailuresStreamSocketClient(
            socketPathValue = server.socketPath.toString(),
            sessionUuidProvider = { sessionUuid },
          )
        sessionUuid = "current-session"
        operation(client)
        val request = server.awaitRequest()
        assertEquals(command, request["command"]?.jsonPrimitive?.content)
        assertEquals(sessionUuid, request["sessionUuid"]?.jsonPrimitive?.content)
      }
  }

  @Test
  fun `a hung reply expires on demand and cancels the watchdog`() {
    val watchdog = FakeSocketRequestWatchdog()
    HungSocketServer().use { server ->
      SocketRequestTask { exchange(server, watchdog) }
        .use { client ->
          server.awaitRequest()
          watchdog.fire()
          val error = assertFailsWith<McpConnectionException> { client.result() }
          assertEquals("Test request timed out after 50ms", error.message)
          assertTrue(error.cause is java.io.IOException)
        }
    }
    watchdog.assertCancelled(TIMEOUT_MS)
  }

  @Test
  fun `a normal reply is returned and its watchdog is cancelled exactly once`() {
    val watchdog = FakeSocketRequestWatchdog()
    HungSocketServer(replyLine = "reply").use { server ->
      SocketRequestTask { exchange(server, watchdog) }
        .use { client ->
          assertEquals("reply", client.result())
        }
    }
    watchdog.assertCancelled(TIMEOUT_MS)
  }

  @Test
  fun `EOF remains a socket closed error`() {
    val watchdog = FakeSocketRequestWatchdog()
    HungSocketServer(closeWithoutReply = true).use { server ->
      SocketRequestTask { exchange(server, watchdog) }
        .use { client ->
          assertEquals(
            "Test socket closed",
            assertFailsWith<McpConnectionException> { client.result() }.message,
          )
        }
    }
    watchdog.assertCancelled(TIMEOUT_MS)
  }

  @Test
  fun `a parser failure is preserved even if expiration is attempted after the reply`() {
    val watchdog = FakeSocketRequestWatchdog(expireOnCancel = true)
    val original = McpConnectionException("invalid reply")
    HungSocketServer(replyLine = "reply").use { server ->
      SocketRequestTask {
        exchange(server, watchdog)
        watchdog.fire()
        throw original
      }
        .use { client ->
          assertSame(original, assertFailsWith<McpConnectionException> { client.result() })
        }
    }
    watchdog.assertCancelled(TIMEOUT_MS)
  }

  @Test
  fun `expiration after a complete reply does not change the result`() {
    val watchdog = FakeSocketRequestWatchdog(expireOnCancel = true)
    HungSocketServer(replyLine = "reply").use { server ->
      SocketRequestTask {
        val reply = exchange(server, watchdog)
        watchdog.fire()
        reply
      }
        .use { client -> assertEquals("reply", client.result()) }
    }
    watchdog.assertCancelled(TIMEOUT_MS)
  }

  @Test
  fun `non-positive timeouts are rejected before the watchdog is armed`() {
    val watchdog =
      object : SocketRequestWatchdog {
        override fun arm(timeoutMs: Long, onExpire: () -> Unit): SocketRequestCancellation =
          throw AssertionError("Invalid timeout must not arm a watchdog")
      }
    HungSocketServer().use { server ->
      listOf(0L, -1L).forEach { timeout ->
        assertFailsWith<IllegalArgumentException> {
          oneShotSocketRequest(server.socketPath.toString(), "request", timeout, "Test", watchdog)
        }
      }
    }
  }

  @Test
  fun `an interrupt propagates and preserves the request thread interrupt flag`() {
    val watchdog = FakeSocketRequestWatchdog()
    val requestThread = AtomicReference<Thread>()
    val started = CountDownLatch(1)
    HungSocketServer().use { server ->
      SocketRequestTask {
        requestThread.set(Thread.currentThread())
        started.countDown()
        try {
          exchange(server, watchdog)
        } catch (error: ClosedByInterruptException) {
          assertTrue(Thread.currentThread().isInterrupted)
          throw error
        }
      }
        .use { client ->
          assertTrue(started.await(TEST_BOUND_SECONDS, TimeUnit.SECONDS))
          server.awaitRequest()
          requestThread.get().interrupt()
          assertFailsWith<ClosedByInterruptException> { client.result() }
        }
    }
    watchdog.assertCancelled(TIMEOUT_MS)
  }

  private fun exchange(server: HungSocketServer, watchdog: SocketRequestWatchdog): String =
    oneShotSocketRequest(server.socketPath.toString(), "request", TIMEOUT_MS, "Test", watchdog)

  private companion object {
    const val TIMEOUT_MS = 50L
    const val TEST_BOUND_SECONDS = 2L
  }
}
