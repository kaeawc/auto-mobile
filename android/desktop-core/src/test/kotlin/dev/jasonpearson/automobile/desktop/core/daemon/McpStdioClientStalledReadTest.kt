package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.failures.McpFailuresDataSource
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Test

/**
 * #10157 review: the stdio client read the child's pipe on the calling thread under its I/O lock. A
 * pipe read ignores [Thread.interrupt], so a stalled server pinned the caller past any timeout or
 * cancellation. The fake child here models exactly that: its pipe read swallows interrupts.
 *
 * Nothing sleeps: the server answers synchronously from its stdin flush, and every wait is a latch
 * or a join bounded only so that a regression fails instead of hanging.
 */
class McpStdioClientStalledReadTest {
  private val threads = CopyOnWriteArrayList<Thread>()
  private val clients = CopyOnWriteArrayList<McpStdioClient>()

  @After
  fun tearDown() {
    clients.forEach { it.close() }
    // close() destroys the fake child, which unblocks every pipe read; join to leave nothing
    // behind.
    threads.forEach { it.join(JOIN_MS) }
  }

  @Test
  fun `a normal reply still works`() {
    val server = FakeStdioServer { s, request ->
      s.replyContents(request, "text-for-${request.uri}")
    }
    val client = clientFor(server)

    val contents = client.readResource("automobile:failures")

    assertEquals(listOf("text-for-automobile:failures"), contents.map { it.text })
  }

  @Test
  fun `an interrupted caller is released even though the pipe read ignores interrupts`() {
    val stalled = CountDownLatch(1)
    val server = FakeStdioServer { s, request ->
      if (request.method == "resources/read") {
        stalled.countDown()
        s.withhold(request)
      }
    }
    val client = clientFor(server)
    val outcome = AtomicInteger()
    val caller = startThread {
      try {
        client.readResource("automobile:failures")
      } catch (_: InterruptedException) {
        outcome.set(INTERRUPTED)
      }
    }
    assertTrue(stalled.await(JOIN_MS, TimeUnit.MILLISECONDS), "request never reached the server")

    caller.interrupt()
    caller.join(JOIN_MS)

    assertFalse(caller.isAlive, "the stalled stdio read pinned the caller past the interrupt")
    assertEquals(INTERRUPTED, outcome.get())
  }

  @Test
  fun `a late reply for an abandoned request is not delivered to the next request`() {
    val stalled = CountDownLatch(1)
    val resourceReads = AtomicInteger()
    val server = FakeStdioServer { s, request ->
      if (request.method == "resources/read") {
        if (resourceReads.incrementAndGet() == 1) {
          stalled.countDown()
          s.withhold(request)
        } else {
          // The abandoned request's reply finally arrives, ahead of the new request's own reply.
          s.replyContents(s.withheld.single(), "LATE")
          s.replyContents(request, "FRESH")
        }
      }
    }
    val client = clientFor(server)
    val caller = startThread {
      try {
        client.readResource("automobile:failures")
      } catch (_: InterruptedException) {}
    }
    assertTrue(stalled.await(JOIN_MS, TimeUnit.MILLISECONDS))
    caller.interrupt()
    caller.join(JOIN_MS)
    assertFalse(caller.isAlive)

    val contents = client.readResource("automobile:failures")

    assertEquals(listOf("FRESH"), contents.map { it.text })
    assertEquals(1, server.starts.get(), "abandoning a request must not restart the server")
  }

  @Test
  fun `two concurrent requests each get their own reply`() {
    val reads = CopyOnWriteArrayList<ServerRequest>()
    val bothSent = CountDownLatch(2)
    val server = FakeStdioServer { s, request ->
      if (request.method == "resources/read") {
        reads += request
        bothSent.countDown()
        if (reads.size == 2) {
          // Answer out of order so a first-line-wins reader would cross the replies.
          s.replyContents(reads[1], "reply-for-${reads[1].uri}")
          s.replyContents(reads[0], "reply-for-${reads[0].uri}")
        }
      }
    }
    val client = clientFor(server)
    val results = java.util.concurrent.ConcurrentHashMap<String, String?>()
    val callers =
      listOf("automobile:a", "automobile:b").map { uri ->
        startThread { results[uri] = client.readResource(uri).single().text }
      }
    callers.forEach { it.join(JOIN_MS) }

    assertTrue(bothSent.await(JOIN_MS, TimeUnit.MILLISECONDS))
    assertEquals("reply-for-automobile:a", results["automobile:a"])
    assertEquals("reply-for-automobile:b", results["automobile:b"])
  }

  @Test
  fun `a stalled stdio read makes the failures dashboard return its timeout error and frees its io thread`() =
    runTest(timeout = 10.seconds) {
      val stalled = CountDownLatch(1)
      val reads = AtomicInteger()
      val server = FakeStdioServer { s, request ->
        if (request.method == "resources/read") {
          if (reads.incrementAndGet() == 1) {
            stalled.countDown()
            s.withhold(request)
          } else {
            s.replyContents(request, FAILURES_JSON)
          }
        }
      }
      val client = clientFor(server)
      val ioExecutor = Executors.newSingleThreadExecutor {
        Thread(it, "failures-io-stalled-test").apply { isDaemon = true }
      }
      val io = ioExecutor.asCoroutineDispatcher()
      try {
        val ui = StandardTestDispatcher(testScheduler)
        val source = McpFailuresDataSource({ client }, ioDispatcher = io, readTimeoutMs = 5_000)

        val load = async(ui) { source.getFailureGroups() }
        runCurrent()
        assertTrue(stalled.await(JOIN_MS, TimeUnit.MILLISECONDS), "read never started")
        advanceTimeBy(5_001)
        runCurrent()

        val result = load.await()
        assertTrue(result is Result.Error, "result=$result")
        assertTrue(result.message!!.contains("Timed out after 5000ms"), result.message)
        // The single IO thread is free again: it can run new work, and a retry succeeds.
        ioExecutor.submit {}.get(JOIN_MS, TimeUnit.MILLISECONDS)
        // Real clock for the retry: runTest would fast-forward its 5 s bound while the real IO
        // thread works.
        val retried = withContext(Dispatchers.Default) { source.getFailureGroups() }
        assertTrue(retried is Result.Success, "retry=$retried")
      } finally {
        io.close()
      }
    }

  // -- Test doubles --

  private fun clientFor(server: FakeStdioServer): McpStdioClient =
    McpStdioClient(command = "unused", processStarter = { server.start() }).also { clients += it }

  private fun startThread(block: () -> Unit): Thread =
    Thread(block, "stalled-read-caller")
      .apply { isDaemon = true }
      .also {
        threads += it
        it.start()
      }

  private class ServerRequest(val id: String, val method: String, val uri: String?)

  /**
   * A child process whose stdout pipe read blocks and, like a real pipe, ignores interrupts. The
   * [handler] runs synchronously when the client flushes a request line to stdin.
   */
  private class FakeStdioServer(private val handler: (FakeStdioServer, ServerRequest) -> Unit) {
    val starts = AtomicInteger()
    val withheld = CopyOnWriteArrayList<ServerRequest>()
    private val stdout = LinkedBlockingQueue<ByteArray>()

    fun start(): Process {
      starts.incrementAndGet()
      return ServerProcess()
    }

    fun withhold(request: ServerRequest) {
      withheld += request
    }

    fun replyContents(request: ServerRequest, text: String) =
      replyRaw(
        request,
        """{"contents":[{"uri":"${request.uri}","mimeType":"application/json","text":${JsonPrimitive(text)}}]}""",
      )

    fun replyRaw(request: ServerRequest, result: String) {
      stdout.put("""{"jsonrpc":"2.0","id":"${request.id}","result":$result}${"\n"}""".toByteArray())
    }

    private fun onRequestLine(line: String) {
      val obj = DaemonJson.parseToJsonElement(line).jsonObject
      val id = (obj["id"] as? JsonPrimitive)?.content ?: return // notification: no reply
      val method = obj["method"]!!.jsonPrimitive.content
      val uri = (obj["params"] as? JsonObject)?.get("uri")?.jsonPrimitive?.content
      val request = ServerRequest(id, method, uri)
      when (method) {
        "initialize" -> replyRaw(request, """{"protocolVersion":"2025-11-25"}""")
        "resources/read" -> handler(this, request)
      }
    }

    private inner class ServerProcess : Process() {
      private val stdin = ByteArrayOutputStream()
      private var alive = true

      override fun getOutputStream(): OutputStream =
        object : OutputStream() {
          override fun write(b: Int) = stdin.write(b)

          override fun flush() {
            val text = stdin.toString(Charsets.UTF_8)
            stdin.reset()
            text.lines().filter { it.isNotBlank() }.forEach(::onRequestLine)
          }
        }

      override fun getInputStream(): InputStream = UninterruptiblePipe()

      override fun getErrorStream(): InputStream = InputStream.nullInputStream()

      override fun waitFor(): Int = 0

      override fun exitValue(): Int = 0

      override fun destroy() {
        alive = false
        stdout.put(EOF)
      }

      override fun isAlive(): Boolean = alive

      override fun destroyForcibly(): Process {
        destroy()
        return this
      }
    }

    /** Blocks like a pipe: [Thread.interrupt] is recorded and ignored. */
    private inner class UninterruptiblePipe : InputStream() {
      private var current: ByteArray? = null
      private var position = 0

      override fun read(): Int {
        val one = ByteArray(1)
        return if (read(one, 0, 1) == -1) -1 else one[0].toInt() and 0xff
      }

      override fun read(b: ByteArray, off: Int, len: Int): Int {
        val chunk =
          current
            ?: takeUninterruptibly().also {
              current = it
              position = 0
            }
        if (chunk === EOF) return -1
        val count = minOf(len, chunk.size - position)
        System.arraycopy(chunk, position, b, off, count)
        position += count
        if (position == chunk.size) current = null
        return count
      }

      private fun takeUninterruptibly(): ByteArray {
        while (true) {
          try {
            return stdout.take()
          } catch (_: InterruptedException) {
            // A blocked pipe read does not react to interrupt; keep waiting.
          }
        }
      }
    }
  }

  private companion object {
    const val JOIN_MS = 5_000L
    const val INTERRUPTED = 1
    val EOF = ByteArray(0)
    const val FAILURES_JSON = """{"groups":[],"generatedAt":"2026-10-05T00:00:00Z"}"""
  }
}
