package dev.jasonpearson.automobile.video

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoStreamWriterTest {
  @Test
  fun reconnectWindowUsesElapsedTimeDespiteWallClockJumps() {
    var elapsedRealtimeMs = 1_000L
    val window = ReconnectWindow({ elapsedRealtimeMs }, durationMs = 10_000L)

    window.start()
    window.onClientAttached()
    elapsedRealtimeMs = 2_000L
    window.onClientDetached()

    // Wall-clock changes do not affect the injected elapsed-time domain.
    elapsedRealtimeMs = 11_999L
    assertFalse(window.isExpired())

    elapsedRealtimeMs = 12_000L
    assertTrue(window.isExpired())
  }

  // --- write-stall watchdog (#4784) -----------------------------------------------------------

  /**
   * Succeeds for the first [blockFromWriteIndex] writes, then parks the writer inside `write()`
   * until [release] (invoked when the owning connection is force-closed), whereupon it throws to
   * mimic a socket closed under a blocked write. Rendezvous latches only coordinate the two
   * threads; the stall deadline itself is driven purely by the injected clock.
   */
  private class BlockingOutputStream(private val blockFromWriteIndex: Int) : OutputStream() {
    private var writeCount = 0
    private val writeEntered = CountDownLatch(1)
    private val unblock = CountDownLatch(1)

    fun awaitWriteEntered(t: Long, u: TimeUnit): Boolean = writeEntered.await(t, u)

    fun release() = unblock.countDown()

    override fun write(b: Int) = record()

    override fun write(b: ByteArray) = record()

    override fun write(b: ByteArray, off: Int, len: Int) = record()

    private fun record() {
      if (writeCount >= blockFromWriteIndex) {
        writeEntered.countDown()
        unblock.await()
        throw IOException("socket closed during blocked write")
      }
      writeCount++
    }
  }

  @Test
  fun blockedWriteIsForceClosedByWatchdogAndWindowExpiresLockFree() {
    var now = 1_000L
    // Header (write index 0) lands; the next packet write parks until the client is force-closed.
    val blocking = BlockingOutputStream(blockFromWriteIndex = 1)
    val connection = FakeClientConnection(outputStream = blocking, onClose = blocking::release)
    val subject = writer({ now }, FakeServerSocket(listOf({ connection })))

    subject.bindServerSocket()
    subject.acceptClients {}
    assertFalse(connection.closed)

    // Simulate the transport writer thread wedged in a blocking packet write.
    val writeThread = Thread { subject.writeAudioPacket(byteArrayOf(1, 2, 3), ptsUs = 0) }
    writeThread.start()
    assertTrue(
      "the packet write must reach the blocking output stream",
      blocking.awaitWriteEntered(2, TimeUnit.SECONDS),
    )

    // Expiry polling is lock-free: it returns even while the write holds `lock` (a client is
    // attached, so it is simply not expired yet).
    assertFalse(subject.reconnectWindowExpired())

    // Before the stall deadline the watchdog leaves the client alone.
    now = 1_000L + VideoStreamWriter.WRITE_STALL_TIMEOUT_MS - 1
    assertFalse(subject.checkWriteStall())
    assertFalse(connection.closed)

    // At the deadline the watchdog force-closes the client out of band.
    now = 1_000L + VideoStreamWriter.WRITE_STALL_TIMEOUT_MS
    val stallStartMs = now
    assertTrue(subject.checkWriteStall())
    assertTrue("stalled write must force-close the client", connection.closed)

    // The wedged write unblocks (throws), runs the detach path, and the writer thread finishes.
    writeThread.join(TimeUnit.SECONDS.toMillis(2))
    assertFalse("the force-close must unblock the wedged write", writeThread.isAlive)

    // The reconnect window now counts from the detach; advancing past it self-expires — lock-free.
    now = stallStartMs + VideoStreamWriter.CLIENT_RECONNECT_WINDOW_MS
    assertTrue(subject.reconnectWindowExpired())

    subject.stop()
  }

  @Test
  fun watchdogIgnoresWritesThatMakeProgress() {
    var now = 1_000L
    val connection = FakeClientConnection()
    val subject = writer({ now }, FakeServerSocket(listOf({ connection })))

    subject.bindServerSocket()
    subject.acceptClients {}

    // A write that completed promptly leaves no in-flight stamp, so no matter how far the clock
    // advances the watchdog must not tear down a healthy client.
    assertTrue(subject.writeAudioPacket(byteArrayOf(1, 2, 3), ptsUs = 0))
    now = 1_000_000L
    assertFalse(subject.checkWriteStall())
    assertFalse(connection.closed)

    subject.stop()
  }

  // --- socket/stream seam driven by fakes -----------------------------------------------------

  /**
   * An output stream that records writes but starts throwing [IOException] once its write count
   * reaches [failFromWriteIndex]. `flush()` is exempt so a successful header still lands before a
   * later packet write fails.
   */
  private class ScriptedOutputStream(private val failFromWriteIndex: Int = Int.MAX_VALUE) :
    OutputStream() {
    var writeCount = 0
      private set

    override fun write(b: Int) = recordWrite()

    override fun write(b: ByteArray) = recordWrite()

    override fun write(b: ByteArray, off: Int, len: Int) = recordWrite()

    private fun recordWrite() {
      if (writeCount >= failFromWriteIndex) {
        throw IOException("scripted write failure at index $writeCount")
      }
      writeCount++
    }
  }

  /** Blocks in `read()` until the owning connection is closed, then reports EOF. */
  private class BlockingUntilClosedInputStream(private val closed: CountDownLatch) : InputStream() {
    override fun read(): Int {
      closed.await()
      return -1
    }
  }

  private class FakeClientConnection(
    override val outputStream: OutputStream = ByteArrayOutputStream(),
    input: InputStream? = null,
    // Default to the shell UID (2000) so existing tests exercise the allowed path; the UID-gating
    // tests below override it with an app-range UID to drive rejection (issue #4728).
    override val peerUid: Int = 2000,
    // Scripted response for the pre-stream handshake read (issue #4729). Null means the peer sends
    // no
    // bytes, so every readFully returns null (a silent connector -> rejected on timeout/EOF); a
    // short
    // array also returns null once exhausted.
    private val handshake: ByteArray? = null,
    private val onClose: () -> Unit = {},
  ) : VideoClientConnection {
    @Volatile var closed = false
    private val closedLatch = CountDownLatch(1)
    private var handshakeOffset = 0
    override val inputStream: InputStream = input ?: BlockingUntilClosedInputStream(closedLatch)

    override fun readFully(count: Int, timeoutMs: Long): ByteArray? {
      val source = handshake ?: return null
      if (handshakeOffset + count > source.size) {
        return null
      }
      val slice = source.copyOfRange(handshakeOffset, handshakeOffset + count)
      handshakeOffset += count
      return slice
    }

    override fun close() {
      if (!closed) {
        closed = true
        closedLatch.countDown()
        onClose()
      }
    }
  }

  /**
   * A connection whose [readFully] increments [handshakeReads] and always returns null (a silent
   * peer). Lets a test assert that a rate-limited connection is dropped *before* the token
   * handshake ever reads from it, i.e. the guard bounds the expensive per-connection work, not just
   * the attach.
   */
  private class HandshakeCountingConnection(override val peerUid: Int = 2000) :
    VideoClientConnection {
    val handshakeReads = AtomicInteger()
    @Volatile var closed = false
    override val outputStream: OutputStream = ByteArrayOutputStream()
    override val inputStream: InputStream = ByteArrayInputStream(ByteArray(0))

    override fun readFully(count: Int, timeoutMs: Long): ByteArray? {
      handshakeReads.incrementAndGet()
      return null
    }

    override fun close() {
      closed = true
    }
  }

  /**
   * Drives [VideoStreamWriter.acceptClients] deterministically: each queued action produces the
   * next `accept()` result (a connection, a thrown [IOException], or the end of the queue which
   * returns `null` so the acceptor loop stops).
   */
  private class FakeServerSocket(actions: List<() -> VideoClientConnection?>) : VideoServerSocket {
    private val queue = ArrayDeque(actions)
    @Volatile var closed = false

    override fun accept(): VideoClientConnection? {
      val next = queue.removeFirstOrNull() ?: return null
      return next()
    }

    override fun close() {
      closed = true
    }
  }

  private fun writer(
    now: () -> Long,
    serverSocket: VideoServerSocket,
    audioEnabled: Boolean = false,
    expectedToken: String? = null,
  ): VideoStreamWriter =
    VideoStreamWriter(
      socketName = "test_socket",
      width = 480,
      height = 800,
      audioEnabled = audioEnabled,
      expectedToken = expectedToken,
      nowMs = now,
      socketFactory = { serverSocket },
    )

  private fun handshakeFrame(
    token: String,
    version: Int = VideoHandshake.PROTOCOL_VERSION,
  ): ByteArray {
    val tokenBytes = token.toByteArray(Charsets.US_ASCII)
    val out = ByteArrayOutputStream()
    out.write(VideoHandshake.MAGIC)
    out.write(version)
    out.write(tokenBytes.size)
    out.write(tokenBytes)
    return out.toByteArray()
  }

  // --- token handshake (issue #4729) ----------------------------------------------------------

  @Test
  fun validHandshakeAttachesAndReceivesStreamHeader() {
    var now = 1_000L
    val token = "session-0001"
    val output = ScriptedOutputStream()
    val connection = FakeClientConnection(outputStream = output, handshake = handshakeFrame(token))
    val attachCount = AtomicInteger()
    val subject = writer({ now }, FakeServerSocket(listOf({ connection })), expectedToken = token)

    subject.bindServerSocket()
    subject.acceptClients { attachCount.incrementAndGet() }

    assertEquals("a valid handshake must attach", 1, attachCount.get())
    assertTrue("an authenticated client must receive the stream header", output.writeCount > 0)
    assertFalse("an authenticated client stays connected", connection.closed)
  }

  @Test
  fun wrongTokenReceivesNoBytesAndIsDisconnected() {
    var now = 1_000L
    val output = ScriptedOutputStream()
    // A well-formed frame carrying the wrong token must be rejected with zero stream bytes.
    val connection =
      FakeClientConnection(outputStream = output, handshake = handshakeFrame("session-9999"))
    val attachCount = AtomicInteger()
    val subject =
      writer({ now }, FakeServerSocket(listOf({ connection })), expectedToken = "session-0001")

    subject.bindServerSocket()
    subject.acceptClients { attachCount.incrementAndGet() }

    assertEquals("a wrong-token peer must never attach", 0, attachCount.get())
    assertEquals("a wrong-token peer must receive no stream bytes", 0, output.writeCount)
    assertTrue("a wrong-token peer must be disconnected", connection.closed)
  }

  @Test
  fun absentHandshakeWithinTimeoutReceivesNoBytesAndIsDisconnected() {
    var now = 1_000L
    val output = ScriptedOutputStream()
    // handshake = null: the peer presents no bytes, so the bounded read returns null (timeout/EOF).
    val connection = FakeClientConnection(outputStream = output, handshake = null)
    val attachCount = AtomicInteger()
    val subject =
      writer({ now }, FakeServerSocket(listOf({ connection })), expectedToken = "session-0001")

    subject.bindServerSocket()
    subject.acceptClients { attachCount.incrementAndGet() }

    assertEquals("a silent connector must never attach", 0, attachCount.get())
    assertEquals("a silent connector must receive no stream bytes", 0, output.writeCount)
    assertTrue("a silent connector must be disconnected", connection.closed)
  }

  @Test
  fun handshakeRejectionDoesNotDisplaceTheCurrentAuthenticatedClient() {
    var now = 1_000L
    val token = "session-0001"
    val authenticated = FakeClientConnection(handshake = handshakeFrame(token))
    val intruder = FakeClientConnection(handshake = handshakeFrame("session-9999"))
    val attachCount = AtomicInteger()
    val subject =
      writer(
        { now },
        FakeServerSocket(listOf({ authenticated }, { intruder })),
        expectedToken = token,
      )

    subject.bindServerSocket()
    subject.acceptClients { attachCount.incrementAndGet() }

    assertEquals("only the authenticated client attaches", 1, attachCount.get())
    assertFalse(
      "the authenticated client must not be displaced by a bad handshake",
      authenticated.closed,
    )
    assertTrue("the intruder must be disconnected", intruder.closed)
    subject.stop()
  }

  @Test
  fun writeFailureDetachesClientButKeepsEncoderAlive() {
    var now = 1_000L
    // Header write (index 0) succeeds; the next packet write fails.
    val connection =
      FakeClientConnection(outputStream = ScriptedOutputStream(failFromWriteIndex = 1))
    val attachCount = AtomicInteger()
    val subject = writer({ now }, FakeServerSocket(listOf({ connection })))

    subject.bindServerSocket()
    subject.acceptClients { attachCount.incrementAndGet() }

    assertEquals(1, attachCount.get())
    assertFalse(connection.closed)

    // The write fails mid-packet: the client is detached, but the contract returns true so the
    // encode loop keeps producing (loop termination is owned by reconnectWindowExpired()).
    val result = subject.writeAudioPacket(byteArrayOf(1, 2, 3), ptsUs = 0)
    assertTrue("write failure must not signal loop termination", result)
    assertTrue("failed write must detach the client", connection.closed)

    // After detach the bounded reconnect window governs shutdown.
    now = 1_000L + VideoStreamWriter.CLIENT_RECONNECT_WINDOW_MS
    assertTrue(subject.reconnectWindowExpired())
  }

  @Test
  fun attachRollsBackWhenStreamHeaderWriteThrows() {
    var now = 1_000L
    // Header write (index 0) throws, so attach must roll back.
    val connection =
      FakeClientConnection(outputStream = ScriptedOutputStream(failFromWriteIndex = 0))
    val attachCount = AtomicInteger()
    val subject = writer({ now }, FakeServerSocket(listOf({ connection })))

    subject.bindServerSocket()
    subject.acceptClients { attachCount.incrementAndGet() }

    assertEquals("failed attach must not report a connected client", 0, attachCount.get())
    assertTrue("rolled-back attach must close the client socket", connection.closed)

    now = 1_000L + VideoStreamWriter.CLIENT_RECONNECT_WINDOW_MS
    assertTrue("rolled-back attach must arm the reconnect window", subject.reconnectWindowExpired())
  }

  @Test
  fun acceptFailureStopsAcceptorWithoutAttaching() {
    var now = 1_000L
    val attachCount = AtomicInteger()
    val subject = writer({ now }, FakeServerSocket(listOf({ throw IOException("accept failed") })))

    subject.bindServerSocket()
    // Must not throw: the acceptor swallows the accept IOException and returns.
    subject.acceptClients { attachCount.incrementAndGet() }

    assertEquals(0, attachCount.get())
    // Nothing ever attached, so the initial clientless window still governs shutdown.
    now = 1_000L + VideoStreamWriter.CLIENT_RECONNECT_WINDOW_MS
    assertTrue(subject.reconnectWindowExpired())
  }

  @Test
  fun reconnectDisplacesPriorClientAndStaleReaderCannotDetachReplacement() {
    var now = 1_000L
    val first = FakeClientConnection()
    val second = FakeClientConnection()
    val attachCount = AtomicInteger()
    val subject = writer({ now }, FakeServerSocket(listOf({ first }, { second })))

    subject.bindServerSocket()
    subject.acceptClients { attachCount.incrementAndGet() }

    assertEquals("both clients attach in turn", 2, attachCount.get())
    assertTrue("the replacement displaces and closes the first client", first.closed)
    assertFalse("the replacement client stays open", second.closed)

    // The first client's command reader wakes (its socket closed) only after the replacement is
    // current, so its clientSocket === client guard is false and it must not detach the second
    // client. The window therefore stays attached regardless of how far the clock advances.
    now = 1_000_000L
    assertFalse(
      "a stale reader from the displaced client must not detach the replacement",
      subject.reconnectWindowExpired(),
    )

    subject.stop()
  }

  @Test
  fun commandReaderDispatchesClientCommandsAndDetachesOnEof() {
    var now = 1_000L
    val received = CountDownLatch(1)
    val lastCommand = AtomicInteger(-1)
    // One command byte then EOF; EOF breaks the read loop and detaches in finally.
    val connection =
      FakeClientConnection(
        input =
          ByteArrayInputStream(byteArrayOf(VideoStreamProtocol.COMMAND_REQUEST_KEY_FRAME.toByte()))
      )
    val subject = writer({ now }, FakeServerSocket(listOf({ connection })))

    subject.startCommandReader { command ->
      lastCommand.set(command)
      received.countDown()
    }
    subject.bindServerSocket()
    subject.acceptClients {}

    assertTrue(
      "command reader must dispatch the client's request byte",
      received.await(2, TimeUnit.SECONDS),
    )
    assertEquals(VideoStreamProtocol.COMMAND_REQUEST_KEY_FRAME, lastCommand.get())
  }

  @Test
  fun commandReaderIgnoresUnknownBytesButStillForwardsKeyFrameRequests() {
    var now = 1_000L
    val keyFrameReceived = CountDownLatch(1)
    val forwarded = CopyOnWriteArrayList<Int>()
    // An unknown control byte (0x02) precedes the sole known command (0x01), then EOF. The unknown
    // byte must never reach the handler; the keyframe request still must (issue #4732).
    val unknownCommand: Int = VideoStreamProtocol.COMMAND_REQUEST_KEY_FRAME + 1
    val connection =
      FakeClientConnection(
        input =
          ByteArrayInputStream(
            byteArrayOf(
              unknownCommand.toByte(),
              VideoStreamProtocol.COMMAND_REQUEST_KEY_FRAME.toByte(),
            )
          )
      )
    val subject = writer({ now }, FakeServerSocket(listOf({ connection })))

    subject.startCommandReader { command ->
      forwarded.add(command)
      if (command == VideoStreamProtocol.COMMAND_REQUEST_KEY_FRAME) {
        keyFrameReceived.countDown()
      }
    }
    subject.bindServerSocket()
    subject.acceptClients {}

    assertTrue(
      "the whitelisted keyframe request must still be forwarded",
      keyFrameReceived.await(2, TimeUnit.SECONDS),
    )
    // The unknown byte was read before the known one; by the time 0x01 arrives it would already
    // have
    // been forwarded if it were not filtered. So the handler must have seen only the known command.
    assertEquals(
      "only the whitelisted command byte may reach the handler",
      listOf(VideoStreamProtocol.COMMAND_REQUEST_KEY_FRAME),
      forwarded.toList(),
    )
  }

  // --- peer-UID gating (SO_PEERCRED, issue #4728) ---------------------------------------------

  @Test
  fun disallowedPeerUidReceivesNoBytesAndIsDisconnected() {
    var now = 1_000L
    val output = ScriptedOutputStream()
    // A normal app connects under its own app-range UID (>= 10000); it must be refused.
    val connection = FakeClientConnection(outputStream = output, peerUid = 10123)
    val attachCount = AtomicInteger()
    val subject = writer({ now }, FakeServerSocket(listOf({ connection })))

    subject.bindServerSocket()
    subject.acceptClients { attachCount.incrementAndGet() }

    assertEquals("a disallowed peer must never be reported as connected", 0, attachCount.get())
    assertEquals("a disallowed peer must receive no stream bytes", 0, output.writeCount)
    assertTrue("a disallowed peer must be disconnected", connection.closed)
  }

  @Test
  fun allowedShellPeerUidAttachesAndReceivesStreamHeader() {
    var now = 1_000L
    val output = ScriptedOutputStream()
    val connection = FakeClientConnection(outputStream = output, peerUid = 2000)
    val attachCount = AtomicInteger()
    val subject = writer({ now }, FakeServerSocket(listOf({ connection })))

    subject.bindServerSocket()
    subject.acceptClients { attachCount.incrementAndGet() }

    assertEquals("an allowed shell peer must attach", 1, attachCount.get())
    assertTrue("an allowed peer must receive the stream header", output.writeCount > 0)
    assertFalse("an allowed peer stays connected", connection.closed)
  }

  @Test
  fun allowedRootPeerUidAttaches() {
    var now = 1_000L
    val connection = FakeClientConnection(peerUid = 0)
    val attachCount = AtomicInteger()
    val subject = writer({ now }, FakeServerSocket(listOf({ connection })))

    subject.bindServerSocket()
    subject.acceptClients { attachCount.incrementAndGet() }

    assertEquals("an allowed root peer must attach", 1, attachCount.get())
    assertFalse(connection.closed)
    subject.stop()
  }

  @Test
  fun disallowedPeerDoesNotDisplaceTheCurrentAllowedClient() {
    var now = 1_000L
    // An allowed client attaches first; a disallowed peer then connects. Rejecting the intruder
    // ahead of the eviction step must leave the legitimate client attached (does not worsen the
    // authenticate-before-evict ordering of issue #4730).
    val allowed = FakeClientConnection(peerUid = 2000)
    val intruder = FakeClientConnection(peerUid = 10222)
    val attachCount = AtomicInteger()
    val subject = writer({ now }, FakeServerSocket(listOf({ allowed }, { intruder })))

    subject.bindServerSocket()
    subject.acceptClients { attachCount.incrementAndGet() }

    assertEquals("only the allowed client attaches", 1, attachCount.get())
    assertFalse("the allowed client must not be displaced by a rejected peer", allowed.closed)
    assertTrue("the intruder must be disconnected", intruder.closed)
    subject.stop()
  }

  // --- connection-storm rate limit (issue #4730) ----------------------------------------------

  @Test
  fun rateLimiterAdmitsUpToMaxThenRejectsWithinWindow() {
    var now = 1_000L
    val limiter = ConnectionRateLimiter({ now }, maxConnections = 3, windowMs = 1_000L)

    assertTrue(limiter.tryAdmit())
    assertTrue(limiter.tryAdmit())
    assertTrue(limiter.tryAdmit())
    assertFalse("a 4th admission in the same window is throttled", limiter.tryAdmit())

    // Still inside the window: capacity has not returned.
    now = 1_500L
    assertFalse("mid-window the budget is still exhausted", limiter.tryAdmit())

    // Once the window slides past the earliest admissions, capacity frees up again.
    now = 2_001L
    assertTrue("capacity returns after the window slides past old admissions", limiter.tryAdmit())
  }

  @Test
  fun connectionStormBeyondRateLimitIsDroppedWithoutDisturbingAdmittedClients() {
    val now = 1_000L
    val max = VideoStreamWriter.MAX_ACCEPTS_PER_RATE_WINDOW
    // Every connection is an allowed peer with the handshake disabled, so only the rate limit — not
    // the UID gate or token handshake — can reject one. A storm of max + 5 lands in one window.
    val connections = List(max + 5) { FakeClientConnection() }
    val attachCount = AtomicInteger()
    val subject = writer({ now }, FakeServerSocket(connections.map { conn -> { conn } }))

    subject.bindServerSocket()
    subject.acceptClients { attachCount.incrementAndGet() }

    assertEquals("only the rate-limit budget of connections is admitted", max, attachCount.get())
    // The last admitted connection is the current client and stays attached.
    assertFalse("the last admitted client stays attached", connections[max - 1].closed)
    // Earlier admits were displaced by the reconnect of the next admitted client.
    for (i in 0 until max - 1) {
      assertTrue("displaced admitted connection $i must be closed", connections[i].closed)
    }
    // Every connection beyond the budget is dropped in O(1) without ever attaching.
    for (i in max until connections.size) {
      assertTrue("throttled connection $i must be closed", connections[i].closed)
    }
    subject.stop()
  }

  @Test
  fun throttledConnectionNeverReachesTheTokenHandshake() {
    val now = 1_000L
    val max = VideoStreamWriter.MAX_ACCEPTS_PER_RATE_WINDOW
    val token = "session-0001"
    // Fill the budget with allowed peers that carry no handshake bytes: with the handshake enabled
    // they would each block for the full HANDSHAKE_READ_TIMEOUT_MS. Once the budget is exhausted
    // the
    // storm connections must be dropped by the rate limit BEFORE that blocking read, proving the
    // guard bounds the expensive per-connection work rather than merely the attach.
    val budgetFillers = List(max) { FakeClientConnection(handshake = handshakeFrame(token)) }
    val stormBeyondBudget = List(3) { HandshakeCountingConnection() }
    val actions: List<() -> VideoClientConnection?> =
      budgetFillers.map { c -> { c } } + stormBeyondBudget.map { c -> { c } }
    val subject = writer({ now }, FakeServerSocket(actions), expectedToken = token)

    subject.bindServerSocket()
    subject.acceptClients {}

    for ((i, conn) in stormBeyondBudget.withIndex()) {
      assertEquals(
        "throttled storm connection $i must be dropped before the handshake read",
        0,
        conn.handshakeReads.get(),
      )
      assertTrue("throttled storm connection $i must be closed", conn.closed)
    }
    subject.stop()
  }

  // --- writePacket success/failure contract (pinning the decision) ----------------------------

  @Test
  fun writeReturnsTrueWithNoClientSoWritesAreDroppedNotFailed() {
    val subject = writer({ 0L }, FakeServerSocket(emptyList()))
    subject.bindServerSocket()

    // No client has attached: writes are silently dropped (cached, for the next client) and must
    // report success so the encode loop is not torn down while waiting for a reconnect.
    assertTrue(subject.writeAudioPacket(byteArrayOf(1, 2, 3), ptsUs = 0))
  }

  @Test
  fun writeReturnsFalseOnlyAfterStop() {
    val subject = writer({ 0L }, FakeServerSocket(emptyList()))
    subject.bindServerSocket()
    subject.stop()

    // Once stopped the contract flips to false, the single condition the encode loop treats as
    // terminal (VideoServer's `if (!success) break`).
    assertFalse(subject.writeAudioPacket(byteArrayOf(1, 2, 3), ptsUs = 0))
  }

  @Test
  fun stopClosesServerSocketAndClearsClient() {
    val serverSocket = FakeServerSocket(listOf({ FakeClientConnection() }))
    val subject = writer({ 0L }, serverSocket)
    subject.bindServerSocket()
    subject.acceptClients {}

    subject.stop()

    assertTrue(serverSocket.closed)
  }

  @Test
  fun constructionWithDefaultFactoryDoesNotBindAFrameworkSocket() {
    // The default socket factory must only be invoked by start()/bindServerSocket(), never during
    // construction, so the writer is constructible under a plain JVM (no LocalServerSocket) and no
    // client can be observed before bind. Not calling bindServerSocket() here, a write is a no-op
    // that reports success (no client yet).
    val subject = VideoStreamWriter(socketName = "s", width = 2, height = 2, nowMs = { 0L })
    assertTrue(subject.writeAudioPacket(byteArrayOf(0), ptsUs = 0))
  }
}
