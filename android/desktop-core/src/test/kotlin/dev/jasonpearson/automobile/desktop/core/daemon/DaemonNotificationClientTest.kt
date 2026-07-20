package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.ServerSocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Drives [DaemonNotificationClient] against a real Unix socket that speaks the control socket's
 * frames.
 *
 * Uses `runBlocking` rather than `runTest`: the client runs a real reader on a real socket, and a
 * virtual clock would skip the waits without any of it having happened.
 */
class DaemonNotificationClientTest {

  private val json = Json { ignoreUnknownKeys = true }
  private val servers = mutableListOf<FakeDaemon>()

  @AfterTest
  fun tearDown() {
    servers.forEach { it.close() }
    servers.clear()
  }

  private fun daemon(
    subscribeSucceeds: Boolean = true,
    subscribeError: String? = null,
    pushes: List<String> = emptyList(),
  ): FakeDaemon = FakeDaemon(subscribeSucceeds, subscribeError, pushes).also { servers.add(it) }

  private fun client(server: FakeDaemon) =
    DaemonNotificationClient(socketPathValue = server.socketPath.toString())

  private suspend fun waitUntil(timeoutMs: Long = 5_000, predicate: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
      if (predicate()) return
      kotlinx.coroutines.delay(10)
    }
    throw AssertionError("Timed out waiting for condition")
  }

  @Test
  fun `subscribes with the documented method`() = runBlocking {
    val server = daemon()
    val client = client(server)

    client.connect()
    waitUntil { client.state.value is NotificationSubscriptionState.Subscribed }

    val request = server.awaitRequest()
    assertEquals("daemon/subscribe-notifications", request["method"]?.jsonPrimitive?.content)
    assertEquals("mcp_request", request["type"]?.jsonPrimitive?.content)

    client.dispose()
  }

  @Test
  fun `a tools list_changed push is surfaced`() = runBlocking {
    val server =
      daemon(
        pushes = listOf("""{"type":"daemon_notification","method":"$TOOLS_LIST_CHANGED_METHOD"}""")
      )
    val client = client(server)
    val seen = mutableListOf<ListChangedKind>()

    // Collect before connecting: notifications has no replay, so a collector started afterwards
    // can miss a push that arrives immediately after the subscribe ack.
    val collector = launch { client.notifications.collect(seen::add) }
    client.connect()
    waitUntil { seen.contains(ListChangedKind.Tools) }

    collector.cancel()
    client.dispose()
  }

  @Test
  fun `a resources list_changed push is surfaced`() = runBlocking {
    val server =
      daemon(
        pushes =
          listOf("""{"type":"daemon_notification","method":"$RESOURCES_LIST_CHANGED_METHOD"}""")
      )
    val client = client(server)
    val seen = mutableListOf<ListChangedKind>()

    // Collect before connecting: notifications has no replay, so a collector started afterwards
    // can miss a push that arrives immediately after the subscribe ack.
    val collector = launch { client.notifications.collect(seen::add) }
    client.connect()
    waitUntil { seen.contains(ListChangedKind.Resources) }

    collector.cancel()
    client.dispose()
  }

  @Test
  fun `an older daemon is reported unsupported and not retried`() = runBlocking {
    // The daemon answers -- it just does not know the method. Reconnecting would loop forever.
    val server =
      daemon(
        subscribeSucceeds = false,
        subscribeError = "Unsupported daemon method: daemon/subscribe-notifications",
      )
    val client = client(server)

    client.connect()
    waitUntil { client.state.value is NotificationSubscriptionState.Unsupported }

    val state = client.state.value as NotificationSubscriptionState.Unsupported
    assertTrue(state.reason.contains("Unsupported daemon method"), state.reason)

    // Only one connection attempt: an unsupported daemon must not be hammered.
    kotlinx.coroutines.delay(300)
    assertEquals(1, server.connectionCount)

    client.dispose()
  }

  @Test
  fun `a notification frame with no id decodes`() = runBlocking {
    // The daemon deliberately omits `id` on pushes; a strict model would fail to decode them.
    val server =
      daemon(
        pushes = listOf("""{"type":"daemon_notification","method":"$TOOLS_LIST_CHANGED_METHOD"}""")
      )
    val client = client(server)
    val seen = mutableListOf<ListChangedKind>()

    // Collect before connecting: notifications has no replay, so a collector started afterwards
    // can miss a push that arrives immediately after the subscribe ack.
    val collector = launch { client.notifications.collect(seen::add) }
    client.connect()
    waitUntil { seen.isNotEmpty() }

    collector.cancel()
    client.dispose()
  }

  @Test
  fun `unknown notification methods are ignored without dropping the subscription`() = runBlocking {
    val server =
      daemon(
        pushes =
          listOf(
            """{"type":"daemon_notification","method":"notifications/something/else"}""",
            """{"type":"daemon_notification","method":"$TOOLS_LIST_CHANGED_METHOD"}""",
          )
      )
    val client = client(server)
    val seen = mutableListOf<ListChangedKind>()

    // Collect before connecting: notifications has no replay, so a collector started afterwards
    // can miss a push that arrives immediately after the subscribe ack.
    val collector = launch { client.notifications.collect(seen::add) }
    client.connect()
    waitUntil { seen.contains(ListChangedKind.Tools) }

    assertEquals(listOf(ListChangedKind.Tools), seen, "the unknown method must not be emitted")
    collector.cancel()
    client.dispose()
  }

  @Test
  fun `unparseable frames do not drop the subscription`() = runBlocking {
    val server =
      daemon(
        pushes =
          listOf(
            "{not json",
            """{"type":"daemon_notification","method":"$TOOLS_LIST_CHANGED_METHOD"}""",
          )
      )
    val client = client(server)
    val seen = mutableListOf<ListChangedKind>()

    // Collect before connecting: notifications has no replay, so a collector started afterwards
    // can miss a push that arrives immediately after the subscribe ack.
    val collector = launch { client.notifications.collect(seen::add) }
    client.connect()
    waitUntil { seen.contains(ListChangedKind.Tools) }

    collector.cancel()
    client.dispose()
  }

  @Test
  fun `a missing socket does not throw and does not spin`() = runBlocking {
    val client =
      DaemonNotificationClient(
        socketPathValue = "/tmp/no-daemon-am.sock",
        initialBackoffMs = 50,
        maxBackoffMs = 100,
      )

    client.connect()
    waitUntil { client.state.value is NotificationSubscriptionState.Disconnected }

    client.dispose()
  }

  @Test
  fun `disconnect returns to idle`() = runBlocking {
    val server = daemon()
    val client = client(server)

    client.connect()
    waitUntil { client.state.value is NotificationSubscriptionState.Subscribed }

    client.disconnect()
    assertEquals(NotificationSubscriptionState.Idle, client.state.value)
    client.dispose()
  }

  @Test
  fun `method names match the daemon's constants`() {
    assertEquals(ListChangedKind.Tools, ListChangedKind.forMethod(TOOLS_LIST_CHANGED_METHOD))
    assertEquals(
      ListChangedKind.Resources,
      ListChangedKind.forMethod(RESOURCES_LIST_CHANGED_METHOD),
    )
    assertEquals(null, ListChangedKind.forMethod("notifications/prompts/list_changed"))
    assertEquals(null, ListChangedKind.forMethod(null))
  }

  @Test
  fun `the fake reports an unsupported daemon`() {
    val source = FakeDaemonNotificationSource(unsupportedReason = "Unsupported daemon method")

    source.connect()

    assertTrue(source.state.value is NotificationSubscriptionState.Unsupported)
  }

  /** A daemon that accepts one subscribe then pushes canned frames. */
  private inner class FakeDaemon(
    private val subscribeSucceeds: Boolean,
    private val subscribeError: String?,
    private val pushes: List<String>,
  ) : AutoCloseable {
    private val tempDir: Path = Files.createTempDirectory(Path.of("/tmp"), "amdn-")
    val socketPath: Path = tempDir.resolve("daemon.sock")

    private val serverChannel =
      ServerSocketChannel.open(StandardProtocolFamily.UNIX)
        .bind(UnixDomainSocketAddress.of(socketPath))

    @Volatile private var captured: JsonObject? = null
    @Volatile
    var connectionCount = 0
      private set

    private val thread = Thread {
      try {
        while (true) {
          serverChannel.accept().use { socket ->
            connectionCount++
            val reader =
              BufferedReader(
                InputStreamReader(Channels.newInputStream(socket), StandardCharsets.UTF_8)
              )
            val out = Channels.newOutputStream(socket)
            val requestLine = reader.readLine() ?: return@use
            captured = json.parseToJsonElement(requestLine).jsonObject
            val id = captured?.get("id")?.jsonPrimitive?.content ?: "1"

            val ack =
              if (subscribeSucceeds) {
                """{"id":"$id","type":"mcp_response","success":true,"result":{"subscribed":true}}"""
              } else {
                """{"id":"$id","type":"mcp_response","success":false,"error":"$subscribeError"}"""
              }
            writeLine(out, ack)
            if (!subscribeSucceeds) return@use

            pushes.forEach { writeLine(out, it) }
            // Hold the connection so the client stays subscribed.
            while (!Thread.currentThread().isInterrupted) {
              Thread.sleep(50)
            }
          }
        }
      } catch (_: Throwable) {
        // Interrupt or client disconnect ends this thread normally.
      }
    }
      .also {
        it.isDaemon = true
        it.start()
      }

    private fun writeLine(out: OutputStream, line: String) {
      out.write((line + "\n").toByteArray(StandardCharsets.UTF_8))
      out.flush()
    }

    suspend fun awaitRequest(): JsonObject {
      val deadline = System.currentTimeMillis() + 5_000
      while (System.currentTimeMillis() < deadline) {
        captured?.let {
          return it
        }
        kotlinx.coroutines.delay(10)
      }
      throw AssertionError("Client did not subscribe")
    }

    override fun close() {
      thread.interrupt()
      serverChannel.close()
      Files.deleteIfExists(socketPath)
      Files.deleteIfExists(tempDir)
    }
  }
}
