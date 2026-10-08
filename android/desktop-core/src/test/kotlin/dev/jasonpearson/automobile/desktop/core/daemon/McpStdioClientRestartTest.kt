package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Test

/**
 * #10236: the stdio client never restarted its server after the child exited. The child here is a
 * scripted fake `Process`; nothing spawns and nothing sleeps. The restart throttle runs on a fake
 * clock, and the waits are latches or a bounded spin on a thread's state, so a regression fails
 * instead of hanging.
 */
class McpStdioClientRestartTest {
  private val server = FakeMcpServer()
  private val clock = FakeClock()
  private val clients = CopyOnWriteArrayList<McpStdioClient>()
  private val threads = CopyOnWriteArrayList<Thread>()

  @After
  fun tearDown() {
    clients.forEach { it.close() }
    server.children.forEach { it.destroy() }
    threads.forEach { it.join(WAIT_MS) }
  }

  @Test
  fun `a child that exited is replaced on the next request`() {
    val client = client()
    assertEquals(listOf("child1"), client.listTools().map { it.name })

    server.children[0].exit()
    val tools = client.listTools()

    assertEquals(listOf("child2"), tools.map { it.name })
    assertEquals(2, server.starts.get())
    assertEquals(
      listOf("initialize", "notifications/initialized", "tools/list"),
      server.children[1].methods(),
      "the new child must be initialized before it is asked anything",
    )
    assertEquals(
      listOf("initialize", "notifications/initialized", "tools/list"),
      server.children[0].methods(),
    )
  }

  @Test
  fun `a request in flight when the child dies fails clearly and is never replayed`() {
    server.behavior = { child, request ->
      if (request.method == "tools/call" && child.index == 1) child.exit() else false
    }
    val client = client()
    client.ping()

    val error =
      assertFailsWith<McpConnectionException> { client.callTool("observe", JsonObject(emptyMap())) }

    assertTrue(
      error.message.orEmpty().contains("exited while 'tools/call' was pending"),
      error.message,
    )
    assertTrue(error.message.orEmpty().contains(COMMAND), "the error names the command")
    assertEquals(1, server.starts.get(), "the failed call must not restart anything by itself")

    // The next request restarts the server; the call that was in flight is not replayed on it.
    assertEquals(listOf("child2"), client.listTools().map { it.name })
    assertEquals(2, server.starts.get())
    assertEquals(1, server.children.flatMap { it.methods() }.count { it == "tools/call" })
    assertEquals(
      listOf("initialize", "notifications/initialized", "tools/list"),
      server.children[1].methods(),
    )
  }

  @Test
  fun `a closed stdin pipe discards the child and the next request restarts it`() {
    val client = client()
    client.ping()

    server.children[0].breakStdin()
    val error = assertFailsWith<McpConnectionException> { client.listTools() }

    assertTrue(
      error.message.orEmpty().contains("exited while 'tools/list' was pending"),
      error.message,
    )
    assertFalse(server.children[0].isAlive, "the broken child must not be left running")
    assertEquals(listOf("child2"), client.listTools().map { it.name })
  }

  @Test
  fun `concurrent first requests share one start and one initialize`() {
    val client = client()
    server.holdInitialize = true

    val first = asyncListTools(client)
    assertTrue(server.initializeSeen.await(WAIT_MS, TimeUnit.MILLISECONDS))
    val second = asyncListTools(client)
    awaitWaiting(second.thread)
    server.releaseInitialize()

    assertEquals(listOf("child1"), first.await())
    assertEquals(listOf("child1"), second.await())
    assertEquals(1, server.starts.get())
    assertEquals(1, server.children[0].methods().count { it == "initialize" })
    assertEquals(1, server.children[0].methods().count { it == "notifications/initialized" })
    assertEquals(2, server.children[0].methods().count { it == "tools/list" })
  }

  @Test
  fun `concurrent requests after an exit share one restart and one initialize`() {
    val client = client()
    client.ping()
    server.children[0].exit()
    server.holdInitialize = true

    val first = asyncListTools(client)
    assertTrue(server.initializeSeen.await(WAIT_MS, TimeUnit.MILLISECONDS))
    val second = asyncListTools(client)
    awaitWaiting(second.thread)
    server.releaseInitialize()

    assertEquals(listOf("child2"), first.await())
    assertEquals(listOf("child2"), second.await())
    assertEquals(2, server.starts.get())
    assertEquals(1, server.children[1].methods().count { it == "initialize" })
    assertEquals(1, server.children[1].methods().count { it == "notifications/initialized" })
  }

  @Test
  fun `a crash loop is bounded then fails fast and recovers after the cool-down`() {
    server.mode = ChildMode.EXITS_AT_ONCE
    val client = client()

    repeat(3) { assertFailsWith<McpConnectionException> { client.listTools() } }
    assertEquals(3, server.starts.get())

    val blocked = assertFailsWith<McpConnectionException> { client.listTools() }
    assertTrue(blocked.message.orEmpty().contains("3 times in a row"), blocked.message)
    assertTrue(blocked.message.orEmpty().contains(COMMAND), blocked.message)
    assertEquals(3, server.starts.get(), "inside the cool-down nothing is started")

    // One trial start after the 10s cool-down; it dies again, so the wait doubles to 20s.
    clock.advanceMs(10_001)
    assertFailsWith<McpConnectionException> { client.listTools() }
    assertEquals(4, server.starts.get())
    clock.advanceMs(19_000)
    assertFailsWith<McpConnectionException> { client.listTools() }
    assertEquals(4, server.starts.get(), "still cooling down after the second trial")

    // The server is fixed: the next trial after the cool-down succeeds and the loop is over.
    server.mode = ChildMode.NORMAL
    clock.advanceMs(1_001)
    assertEquals(listOf("child5"), client.listTools().map { it.name })
    assertEquals(listOf("child5"), client.listTools().map { it.name })
    assertEquals(5, server.starts.get())
  }

  @Test
  fun `a command that cannot be started is throttled the same way`() {
    server.mode = ChildMode.CANNOT_START
    val client = client()

    repeat(3) {
      val error = assertFailsWith<McpConnectionException> { client.listTools() }
      assertTrue(error.message.orEmpty().contains("could not be started"), error.message)
    }
    val blocked = assertFailsWith<McpConnectionException> { client.listTools() }

    assertTrue(blocked.message.orEmpty().contains("3 times in a row"), blocked.message)
    assertEquals(3, server.starts.get())
  }

  @Test
  fun `a child that ran healthily before exiting restarts at once despite earlier quick exits`() {
    val client = client()
    server.mode = ChildMode.EXITS_AT_ONCE
    repeat(2) { assertFailsWith<McpConnectionException> { client.listTools() } }
    server.mode = ChildMode.NORMAL
    assertEquals(listOf("child3"), client.listTools().map { it.name })

    clock.advanceMs(10_001) // the third child proved itself
    server.children[2].exit()

    assertEquals(listOf("child4"), client.listTools().map { it.name })
    server.children[3].exit() // a quick exit again: only one on the books, no throttle yet
    assertEquals(listOf("child5"), client.listTools().map { it.name })
  }

  @Test
  fun `close during a restart leaves no process running`() {
    val client = client()
    client.ping()
    server.children[0].exit()
    server.holdInitialize = true

    val restarting = asyncListTools(client)
    assertTrue(server.initializeSeen.await(WAIT_MS, TimeUnit.MILLISECONDS))
    client.close()

    val error = assertFailsWith<McpConnectionException> { restarting.await() }
    assertTrue(
      error.message.orEmpty().contains("exited while 'initialize' was pending"),
      error.message,
    )
    assertEquals(2, server.starts.get(), "closing must not trigger another start")
    assertTrue(server.children.none { it.isAlive }, "no child may outlive close()")
  }

  @Test
  fun `closing deliberately does not count against the throttle`() {
    val client = client()
    repeat(5) {
      client.ping()
      client.close()
    }

    assertEquals(5, server.starts.get())
    assertEquals(listOf("child6"), client.listTools().map { it.name })
  }

  // -- helpers --

  private fun client(): McpStdioClient =
    McpStdioClient(
        command = COMMAND,
        processStarter = { server.start(clock) },
        nowNanos = clock::nowNanos,
      )
      .also { clients += it }

  private class Async(
    val thread: Thread,
    private val outcome: AtomicReference<Result<List<String>>>,
  ) {
    fun await(): List<String> {
      thread.join(WAIT_MS)
      assertFalse(thread.isAlive, "the caller never returned")
      return outcome.get().getOrThrow()
    }
  }

  private fun asyncListTools(client: McpStdioClient): Async {
    val outcome = AtomicReference<Result<List<String>>>()
    val thread =
      Thread(
          { outcome.set(runCatching { client.listTools().map { it.name } }) },
          "restart-test-caller",
        )
        .apply { isDaemon = true }
    threads += thread
    thread.start()
    return Async(thread, outcome)
  }

  /** Spins (bounded) until [thread] is parked waiting on the handshake it joined. */
  private fun awaitWaiting(thread: Thread) {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(WAIT_MS)
    while (thread.state != Thread.State.WAITING && System.nanoTime() < deadline) {
      Thread.onSpinWait()
    }
    assertEquals(Thread.State.WAITING, thread.state, "the second caller did not join the handshake")
  }

  private class FakeClock {
    @Volatile private var nanos = 0L

    fun nowNanos(): Long = nanos

    fun advanceMs(ms: Long) {
      nanos += TimeUnit.MILLISECONDS.toNanos(ms)
    }
  }

  private enum class ChildMode {
    NORMAL,
    EXITS_AT_ONCE,
    CANNOT_START,
  }

  private class Req(val id: String?, val method: String)

  private class FakeMcpServer {
    val starts = AtomicInteger()
    val children = CopyOnWriteArrayList<FakeChild>()

    @Volatile var mode = ChildMode.NORMAL

    /** Return true when the request was handled; false falls through to the default replies. */
    @Volatile var behavior: (FakeChild, Req) -> Boolean = { _, _ -> false }

    @Volatile var holdInitialize = false
    @Volatile var initializeSeen = java.util.concurrent.CountDownLatch(1)
    private val held = AtomicReference<Pair<FakeChild, Req>?>()

    fun start(clock: FakeClock): Process {
      starts.incrementAndGet()
      if (mode == ChildMode.CANNOT_START) {
        throw IOException("Cannot run program \"fake-mcp\"")
      }
      val child = FakeChild(starts.get(), this)
      children += child
      if (mode == ChildMode.EXITS_AT_ONCE) {
        child.exit()
      }
      return child
    }

    fun releaseInitialize() {
      holdInitialize = false
      held.getAndSet(null)?.let { (child, request) -> child.replyInitialize(request) }
    }

    fun handle(child: FakeChild, request: Req) {
      child.received += request.method
      if (behavior(child, request)) return
      when (request.method) {
        "initialize" ->
          if (holdInitialize) {
            held.set(child to request)
            initializeSeen.countDown()
          } else {
            child.replyInitialize(request)
          }
        "tools/list" -> child.reply(request, """{"tools":[{"name":"child${child.index}"}]}""")
      }
    }
  }

  private class FakeChild(val index: Int, private val server: FakeMcpServer) : Process() {
    val received = CopyOnWriteArrayList<String>()
    private val stdout = LinkedBlockingQueue<ByteArray>()
    private val stdin = ByteArrayOutputStream()
    @Volatile private var alive = true
    @Volatile private var stdinBroken = false

    fun methods(): List<String> = received.toList()

    fun replyInitialize(request: Req) = reply(request, """{"protocolVersion":"2025-11-25"}""")

    fun reply(request: Req, result: String) {
      stdout.put("""{"jsonrpc":"2.0","id":"${request.id}","result":$result}${"\n"}""".toByteArray())
    }

    fun breakStdin() {
      stdinBroken = true
    }

    /** The child exits: it stops being alive and its stdout reaches EOF. */
    fun exit(): Boolean {
      alive = false
      stdout.put(EOF)
      return true
    }

    override fun getOutputStream(): OutputStream =
      object : OutputStream() {
        override fun write(b: Int) {
          if (stdinBroken) throw IOException("Broken pipe")
          stdin.write(b)
        }

        override fun flush() {
          if (stdinBroken) throw IOException("Broken pipe")
          val text = stdin.toString(Charsets.UTF_8)
          stdin.reset()
          text.lines().filter { it.isNotBlank() }.forEach(::onLine)
        }
      }

    private fun onLine(line: String) {
      val obj = DaemonJson.parseToJsonElement(line).jsonObject
      val id = (obj["id"] as? JsonPrimitive)?.content
      server.handle(this, Req(id, obj.getValue("method").jsonPrimitive.content))
    }

    override fun getInputStream(): InputStream =
      object : InputStream() {
        private var current: ByteArray? = null
        private var position = 0

        override fun read(): Int {
          val one = ByteArray(1)
          return if (read(one, 0, 1) == -1) -1 else one[0].toInt() and 0xff
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
          val chunk =
            current
              ?: stdout.take().also {
                current = it
                position = 0
              }
          if (chunk === EOF) {
            stdout.put(EOF) // stay at EOF for any later read
            return -1
          }
          val count = minOf(len, chunk.size - position)
          System.arraycopy(chunk, position, b, off, count)
          position += count
          if (position == chunk.size) current = null
          return count
        }
      }

    override fun getErrorStream(): InputStream = InputStream.nullInputStream()

    override fun waitFor(): Int = 0

    override fun exitValue(): Int = 0

    override fun destroy() {
      exit()
    }

    override fun destroyForcibly(): Process {
      exit()
      return this
    }

    override fun isAlive(): Boolean = alive
  }

  private companion object {
    const val COMMAND = "fake-mcp --stdio"
    const val WAIT_MS = 5_000L
    val EOF = ByteArray(0)
  }
}
