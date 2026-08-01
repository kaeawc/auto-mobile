package dev.jasonpearson.automobile.video

import android.media.MediaCodec
import android.os.SystemClock
import java.io.IOException
import java.io.OutputStream
import java.nio.ByteBuffer

/**
 * Tracks the bounded clientless window using a monotonic clock so wall-clock changes cannot
 * prematurely expire or indefinitely extend a capture session.
 */
internal class ReconnectWindow(
  private val clock: () -> Long,
  private val durationMs: Long,
) {
  // @Volatile: expiry is polled off the write lock (VideoStreamWriter.reconnectWindowExpired) so a
  // transport write wedged while holding that lock can never starve the self-expiry check (issue
  // #4784). Mutations still happen under the writer's lock; only these reads are lock-free.
  @Volatile private var clientlessSinceMs: Long = NO_CLIENTLESS
  @Volatile private var clientAttached = false

  fun start() {
    clientAttached = false
    clientlessSinceMs = clock()
  }

  fun onClientAttached() {
    clientAttached = true
    clientlessSinceMs = NO_CLIENTLESS
  }

  fun onClientDetached() {
    clientAttached = false
    clientlessSinceMs = clock()
  }

  fun isExpired(): Boolean {
    if (clientAttached) return false
    val clientlessSince = clientlessSinceMs
    if (clientlessSince == NO_CLIENTLESS) return false
    return clock() - clientlessSince >= durationMs
  }

  private companion object {
    /**
     * Sentinel for "a client is (or may be) attached", i.e. the clientless window is not running.
     */
    const val NO_CLIENTLESS = Long.MIN_VALUE
  }
}

/**
 * Sliding-window admission limiter for the accept loop (issue #4730). Bounds how many connections
 * the single `video-client-acceptor` thread will carry into the bounded token handshake per
 * [windowMs], so a connection storm cannot wedge that thread inside repeated
 * [VideoStreamWriter.HANDSHAKE_READ_TIMEOUT_MS] reads or churn CPU. Timestamps are supplied by an
 * injected monotonic clock so the limit is deterministically fake-testable; only the acceptor
 * thread touches an instance, so it needs no internal synchronization.
 */
internal class ConnectionRateLimiter(
  private val clock: () -> Long,
  private val maxConnections: Int,
  private val windowMs: Long,
) {
  // Bounded by maxConnections: a rejected attempt records nothing, so the deque never grows beyond
  // the admitted set still inside the trailing window.
  private val admittedAtMs = ArrayDeque<Long>()

  /**
   * Record an admission at the current time and report whether it is within the rate. Evicts
   * timestamps that fell out of the trailing [windowMs] first, then admits (and remembers) the
   * attempt only while fewer than [maxConnections] remain in the window; otherwise returns false
   * and remembers nothing, so a sustained storm neither grows the deque nor advances the window.
   */
  fun tryAdmit(): Boolean {
    val now = clock()
    val cutoff = now - windowMs
    while (admittedAtMs.isNotEmpty() && admittedAtMs.first() <= cutoff) {
      admittedAtMs.removeFirst()
    }
    if (admittedAtMs.size >= maxConnections) return false
    admittedAtMs.addLast(now)
    return true
  }
}

/**
 * Writes encoded video packets to a LocalSocket using the VideoStreamProtocol binary framing. A
 * disconnected client is replaceable: the writer retains codec configuration plus the latest
 * complete keyframe and replays them before live packets to the next client.
 */
class VideoStreamWriter(
  private val socketName: String,
  private val width: Int,
  private val height: Int,
  private val audioEnabled: Boolean = false,
  // The session token the connecting client must present in the pre-stream handshake (issue #4729).
  // Null disables the handshake (a token-less/legacy launch), preserving prior behavior; the host
  // always launches with a token, so production always requires the handshake.
  private val expectedToken: String? = null,
  private val nowMs: () -> Long = { SystemClock.elapsedRealtime() },
  private val socketFactory: VideoServerSocketFactory = LocalServerSocketFactory,
  // Supplies the CURRENT display rotation (0..3) attested on each CONFIG packet (issue #4786). Read
  // on the encode-loop thread at config-packet time — including the #4785 rotation swap's new
  // config packet — so the value matches the encoder that just emitted the SPS/PPS. Defaults to a
  // constant 0 for token-less/legacy launches and unit tests that do not exercise rotation.
  private val rotationProvider: () -> Int = { 0 },
) {
  private data class CachedPacket(
    val trackId: Int,
    val ptsAndFlags: Long,
    val data: ByteArray,
  )

  private var serverSocket: VideoServerSocket? = null
  // @Volatile: stop() closes this without the lock to unblock a writer thread wedged in a
  // blocking socket write (the writer holds `lock` for the duration of that write).
  @Volatile private var clientSocket: VideoClientConnection? = null
  private var outputStream: OutputStream? = null
  private var commandHandler: ((Int) -> Unit)? = null
  private val lock = Any()
  private val packetCache = VideoPacketCache()
  private val reconnectWindow = ReconnectWindow(nowMs, CLIENT_RECONNECT_WINDOW_MS)
  // Bounds the accept loop's per-connection handshake work against a storm (issue #4730).
  private val connectionRateLimiter =
    ConnectionRateLimiter(nowMs, MAX_ACCEPTS_PER_RATE_WINDOW, ACCEPT_RATE_WINDOW_MS)

  // Decouple encode from transport (#4749): the encode loop offers to a drop-oldest single-slot
  // handoff and returns immediately; this dedicated thread drains it into the socket, so a stalled
  // reader can never back-pressure MediaCodec's Surface input.
  private val handoff = FrameHandoff()
  // @Volatile: assigned on the thread that calls start(), read by stop() on the shutdown hook.
  @Volatile private var writerThread: Thread? = null

  // Write-stall watchdog (#4784): a half-open transport (host suspended, adb dropped without RST)
  // lets output.write() block forever while the writer thread holds `lock`. Neither the write (no
  // IOException) nor the command reader (no EOF) observes the dead consumer, so the reconnect
  // window never resumes. We stamp when a client write enters the blocking call and clear it on
  // return; the watchdog reads the stamp off the lock and force-closes the client when a write has
  // been in flight past the deadline, which makes the wedged write throw and run the normal detach.
  // @Volatile: written under `lock` on the writer/acceptor thread, read off-lock by the watchdog.
  @Volatile private var writeStartedAtMs: Long = NO_WRITE_IN_PROGRESS
  @Volatile private var watchdogThread: Thread? = null

  @Volatile private var stopped = false

  companion object {
    /** Keep capture warm long enough for ADB/daemon local-socket recovery. */
    const val CLIENT_RECONNECT_WINDOW_MS = 5_000L

    /** Upper bound on how long [stop] waits for the transport writer thread to unwind. */
    const val WRITER_JOIN_TIMEOUT_MS = 200L

    /**
     * A client write in flight longer than this is treated as a wedged half-open transport: the
     * watchdog force-closes the client so the blocked write throws and the normal detach +
     * reconnect window runs. Kept in the reconnect-window order of magnitude so a genuinely
     * slow-but-alive consumer is not detached for a transient congestion blip.
     */
    const val WRITE_STALL_TIMEOUT_MS = 5_000L

    /** How often the watchdog thread polls for a stalled write. */
    const val WRITE_STALL_POLL_MS = 500L

    /** Sentinel for [writeStartedAtMs] meaning no client write is currently in flight. */
    const val NO_WRITE_IN_PROGRESS = Long.MIN_VALUE

    /**
     * Upper bound on the pre-stream token handshake read (issue #4729). A silent connector that
     * holds the accept slot without presenting the token is force-rejected after this deadline so
     * it cannot wedge the acceptor. Kept short: the legitimate host writes the handshake
     * immediately on connect.
     */
    const val HANDSHAKE_READ_TIMEOUT_MS = 2_000L

    /**
     * Admission ceiling for the accept loop: at most this many connections per
     * [ACCEPT_RATE_WINDOW_MS] are carried into the bounded token handshake (issue #4730). A
     * connection storm past this budget is dropped in O(1) — after the cheap UID gate, before the
     * blocking handshake read — so it can neither wedge the single acceptor thread inside repeated
     * [HANDSHAKE_READ_TIMEOUT_MS] reads nor churn CPU. Generous relative to legitimate reconnects,
     * which arrive at most a few times per session recovery.
     */
    const val MAX_ACCEPTS_PER_RATE_WINDOW = 10

    /** Trailing window over which [MAX_ACCEPTS_PER_RATE_WINDOW] admissions are counted. */
    const val ACCEPT_RATE_WINDOW_MS = 1_000L

    /**
     * Peer UIDs allowed to receive the screen stream, checked against `SO_PEERCRED` on every
     * `accept()` before any byte is written (issue #4728).
     *
     * The legitimate host always reaches the abstract socket through `adbd`, which runs as shell
     * (AID_SHELL, UID 2000); root (AID_ROOT, UID 0) covers `adb root` and eng/rooted builds where
     * the daemon is relayed as root. Every normal app connects under its own app UID (>= 10000) and
     * is therefore structurally excluded. Abstract-namespace local sockets have no filesystem
     * permissions, so this kernel-supplied credential is the only access-control barrier available.
     */
    val ALLOWED_PEER_UIDS = setOf(0, 2000)

    /** "h264" as big-endian int: 0x68323634 */
    const val CODEC_ID_H264 = VideoStreamProtocol.CODEC_ID_H264
    /** "amux" as big-endian int: 0x616d7578 */
    const val CODEC_ID_AMUX = VideoStreamProtocol.CODEC_ID_AMUX
    /** "s16l" as big-endian int: 0x7331366c */
    const val CODEC_ID_PCM16 = VideoStreamProtocol.CODEC_ID_PCM16
    const val TRACK_ID_VIDEO = VideoStreamProtocol.TRACK_ID_VIDEO
    const val TRACK_ID_AUDIO = VideoStreamProtocol.TRACK_ID_AUDIO

    /** Bit 63: codec configuration data */
    const val PACKET_FLAG_CONFIG = VideoStreamProtocol.PACKET_FLAG_CONFIG

    /** Bit 62: key frame (I-frame) */
    const val PACKET_FLAG_KEY_FRAME = VideoStreamProtocol.PACKET_FLAG_KEY_FRAME

    /** Mask for PTS (bits 0-58); bits 59-60 carry the CONFIG-packet rotation (issue #4786). */
    const val PTS_MASK = VideoStreamProtocol.PTS_MASK
  }

  /**
   * Bind the abstract LocalSocket and accept clients in the background.
   *
   * The callback runs after the cached packets are written, so callers can request a current IDR
   * without delaying initial decoder setup.
   */
  fun start(onClientConnected: () -> Unit = {}) {
    bindServerSocket()
    writerThread =
      Thread({ drainToTransport() }, "video-transport-writer").apply {
        isDaemon = true
        start()
      }
    watchdogThread =
      Thread({ runWriteWatchdog() }, "video-write-watchdog").apply {
        isDaemon = true
        start()
      }
    Thread(
        { acceptClients(onClientConnected) },
        "video-client-acceptor",
      )
      .apply { isDaemon = true }
      .start()
  }

  /**
   * The single consumer of [handoff]: blocks for the next encoded packet and writes it to the
   * current client. Isolating the blocking transport write on this thread is what keeps a slow or
   * stalled reader from back-pressuring the encode loop.
   */
  private fun drainToTransport() {
    while (!stopped) {
      val frame = handoff.take() ?: break
      synchronized(lock) { writePacketDataLocked(TRACK_ID_VIDEO, frame.ptsAndFlags, frame.data) }
    }
  }

  /**
   * The write-stall watchdog loop. Polls [checkWriteStall] off the write lock so it can act while
   * the writer thread is wedged inside a blocking [OutputStream.write] holding `lock`. Runs on its
   * own daemon thread; unit tests call [checkWriteStall] directly with an injected clock instead.
   */
  private fun runWriteWatchdog() {
    while (!stopped) {
      checkWriteStall()
      try {
        Thread.sleep(WRITE_STALL_POLL_MS)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        return
      }
    }
  }

  /**
   * Force-detach a client whose transport write has been in flight past [WRITE_STALL_TIMEOUT_MS].
   *
   * Deliberately lock-free: the wedged write holds `lock`, so this must NOT take `lock`. Closing
   * the client socket makes the blocked `output.write` throw [IOException], which runs the writer
   * thread's own catch ([closeClientLocked] + [ReconnectWindow.onClientDetached]) and lets the
   * reconnect window resume counting toward self-expiry.
   *
   * @return true when it force-closed a stalled client this call, false otherwise.
   */
  internal fun checkWriteStall(): Boolean {
    val startedAt = writeStartedAtMs
    if (startedAt == NO_WRITE_IN_PROGRESS) return false
    if (nowMs() - startedAt < WRITE_STALL_TIMEOUT_MS) return false
    val client = clientSocket ?: return false
    println(
      "VIDEO_CLIENT_WRITE_STALL socket=$socketName force-closing after ${nowMs() - startedAt}ms"
    )
    try {
      client.close()
    } catch (_: IOException) {
      // Already gone; the wedged write will still observe the close and throw.
    }
    return true
  }

  /**
   * Bind the listening socket and arm the reconnect window without spawning the acceptor thread.
   * Split out from [start] so unit tests can drive [acceptClients] synchronously on the test thread
   * with an injected [socketFactory].
   */
  internal fun bindServerSocket() {
    serverSocket = socketFactory.create(socketName)
    synchronized(lock) { reconnectWindow.start() }
    println("Waiting for client connection on localabstract:$socketName")
  }

  /**
   * Registers a callback for every current or future bidirectional client. The reader is
   * deliberately owned by the writer so reconnects do not lose the keyframe-request control
   * channel.
   */
  fun startCommandReader(onCommand: (Int) -> Unit) {
    synchronized(lock) {
      commandHandler = onCommand
    }
  }

  internal fun acceptClients(onClientConnected: () -> Unit) {
    while (!stopped) {
      val client =
        try {
          serverSocket?.accept() ?: return
        } catch (e: IOException) {
          if (!stopped) {
            println("Error accepting video client: ${e.message}")
          }
          return
        }

      // Gate on the peer's SO_PEERCRED UID before touching any shared state or writing a byte
      // (issue #4728). Rejecting here — ahead of the closeClientLocked() eviction below — means an
      // unauthorized peer neither displaces the current client nor observes any stream bytes, so it
      // also avoids worsening the authenticate-before-evict ordering tracked by issue #4730.
      val peerUid = client.peerUid
      if (peerUid !in ALLOWED_PEER_UIDS) {
        println(
          "VIDEO_CLIENT_REJECTED socket=$socketName uid=$peerUid not in allowed set " +
            "$ALLOWED_PEER_UIDS; disconnecting"
        )
        try {
          client.close()
        } catch (_: IOException) {
          // Best-effort close of a rejected peer; nothing was written, so a failure here is benign.
        }
        continue
      }

      // Bound the accept loop against a connection storm (issue #4730). The check sits after the
      // O(1) UID gate — so untrusted app-UID floods are already filtered and never consume the
      // budget or throttle a legitimate host reconnect — and ahead of the blocking token handshake,
      // which is the expensive per-connection work a flood would otherwise use to wedge this single
      // acceptor thread for HANDSHAKE_READ_TIMEOUT_MS each. Over-budget connections are dropped in
      // O(1) without touching shared state, so the attached client is undisturbed.
      if (!connectionRateLimiter.tryAdmit()) {
        println(
          "VIDEO_CLIENT_RATE_LIMITED socket=$socketName exceeded " +
            "$MAX_ACCEPTS_PER_RATE_WINDOW accepts/${ACCEPT_RATE_WINDOW_MS}ms; disconnecting"
        )
        try {
          client.close()
        } catch (_: IOException) {
          // Best-effort close of a throttled peer; nothing was written, so a failure here is
          // benign.
        }
        continue
      }

      // Require the token handshake before displacing the current client or writing a byte (issue
      // #4729). Reading happens off `lock` (it is a bounded blocking read) and ahead of the
      // closeClientLocked() eviction, so a wrong/absent token neither evicts the legitimate client
      // nor
      // leaks any stream bytes — the same authenticate-before-evict ordering the UID gate above
      // keeps.
      if (!handshakeAccepted(client)) {
        try {
          client.close()
        } catch (_: IOException) {
          // Best-effort close of a rejected peer; nothing was written, so a failure here is benign.
        }
        continue
      }

      val attached =
        synchronized(lock) {
          closeClientLocked()
          clientSocket = client
          outputStream = client.outputStream
          try {
            writeStreamHeaderLocked()
            replayCachedVideoLocked()
            reconnectWindow.onClientAttached()
            true
          } catch (e: IOException) {
            println("Error attaching video client: ${e.message}")
            closeClientLocked()
            reconnectWindow.onClientDetached()
            false
          }
        }
      if (!attached) {
        continue
      }

      println("Client connected, writing stream header")
      startCommandReaderFor(client)
      onClientConnected()
    }
  }

  /**
   * Validate the client's pre-stream token handshake. Returns true when no token is configured (the
   * handshake is disabled) or the client presented a well-formed frame carrying the expected token;
   * false on any mismatch/timeout, logging a machine-parseable reason. Extracted so [acceptClients]
   * stays under the complexity ratchet and the accept path reads as gate -> gate -> attach.
   */
  internal fun handshakeAccepted(client: VideoClientConnection): Boolean {
    val token = expectedToken ?: return true
    return when (
      val result = VideoHandshake.read(client, token, HANDSHAKE_READ_TIMEOUT_MS, nowMs)
    ) {
      is VideoHandshake.Result.Accepted -> true
      is VideoHandshake.Result.Rejected -> {
        println(
          "VIDEO_CLIENT_HANDSHAKE_REJECTED socket=$socketName reason=${result.reason}; disconnecting"
        )
        false
      }
    }
  }

  private fun startCommandReaderFor(client: VideoClientConnection) {
    val input = client.inputStream
    Thread(
        {
          try {
            while (!stopped && isCurrentClient(client)) {
              val command = input.read()
              if (command < 0) break
              // Whitelist control bytes before forwarding (issue #4732). Unknown values are
              // unauthenticated control input on the shared socket; ignoring (and debug-logging)
              // them keeps the control surface minimal. Once the #4729 handshake authenticates the
              // connection this channel is implicitly authenticated too, but we validate anyway for
              // defense-in-depth. The reader still reads one byte per iteration and buffers
              // nothing,
              // so an unknown-byte flood cannot grow memory or wedge the daemon-threaded reader.
              if (!VideoStreamProtocol.isKnownCommand(command)) {
                println("VIDEO_COMMAND_IGNORED socket=$socketName unknown command byte=$command")
                continue
              }
              commandHandler?.invoke(command)
            }
          } catch (_: IOException) {
            // The write path or a replacement connection owns cleanup.
          } finally {
            synchronized(lock) {
              if (clientSocket === client) {
                closeClientLocked()
                reconnectWindow.onClientDetached()
              }
            }
          }
        },
        "video-command-reader",
      )
      .apply { isDaemon = true }
      .start()
  }

  /**
   * Hand one encoded video packet off to the transport writer. Copies the buffer, caches decoder
   * state, then offers to the drop-oldest [handoff] — all non-blocking, so the caller may release
   * the MediaCodec output buffer immediately without waiting on the socket.
   *
   * Caching happens here on the producer side, before the handoff can drop anything, so a dropped
   * live packet never removes SPS/PPS or the latest IDR from the reconnect replay cache.
   *
   * @return false once the writer has been [stop]ped, signalling the encode loop to exit.
   */
  fun writePacket(buffer: ByteBuffer, bufferInfo: MediaCodec.BufferInfo): Boolean {
    val data = ByteArray(bufferInfo.size)
    buffer.position(bufferInfo.offset)
    buffer.get(data, 0, bufferInfo.size)
    val isConfig = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
    // Attest the CURRENT rotation only on the CONFIG packet (SPS/PPS), which is re-emitted at
    // stream
    // start and on every #4785 rotation-driven encoder swap; the cache remembers it so a reconnect
    // replays the current rotation for free (issue #4786).
    val ptsAndFlags =
      VideoStreamProtocol.ptsAndFlags(
        bufferInfo.presentationTimeUs,
        isConfig,
        (bufferInfo.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0,
        rotation = if (isConfig) rotationProvider() else 0,
      )
    synchronized(lock) { packetCache.remember(CachedVideoPacket(ptsAndFlags, data)) }
    return handoff.offer(EncodedVideoFrame(ptsAndFlags, data))
  }

  fun writeAudioPacket(data: ByteArray, ptsUs: Long): Boolean =
    synchronized(lock) {
      writePacketDataLocked(TRACK_ID_AUDIO, ptsUs and PTS_MASK, data)
    }

  /**
   * True once the initial or replacement client misses the bounded reconnect window.
   *
   * Lock-free by design (#4784): [ReconnectWindow] state is volatile, so a transport write wedged
   * inside `lock` on the writer thread cannot starve the encode loop's self-expiry poll.
   */
  fun reconnectWindowExpired(): Boolean = reconnectWindow.isExpired()

  /**
   * Atomically clear the replay cache for a device-rotation encoder swap (issue #4785).
   *
   * Held under the same `lock` that guards client attach (`acceptClients` ->
   * `replayCachedVideoLocked`), so the swap is atomic with respect to the writer: a client
   * attaching mid-swap serializes either fully before this reset (replays the old encoder's
   * coherent config+IDR) or fully after it (replays nothing yet, then requests a keyframe), and can
   * never observe the new encoder's SPS/PPS paired with the stale pre-rotation IDR. The caller
   * resets here after tearing down the old encoder and before starting the new one; the new
   * encoder's config+IDR then repopulate the cache through the normal [writePacket] path, so a
   * later reconnect replays the new coherent pair.
   */
  fun resetReplayCacheForResize() {
    synchronized(lock) { packetCache.reset() }
  }

  private fun writeStreamHeaderLocked() {
    val header =
      if (audioEnabled) {
        VideoStreamProtocol.muxHeader(
          width,
          height,
          AudioCapture.SAMPLE_RATE_HZ,
          AudioCapture.CHANNELS,
        )
      } else {
        VideoStreamProtocol.legacyHeader(width, height)
      }
    trackingWriteStall {
      outputStream!!.write(header)
      outputStream!!.flush()
    }
  }

  /**
   * Run a blocking client I/O action while advertising to the watchdog that a write is in flight. A
   * stamp of [nowMs] is published before the action and cleared after (success or throw) so
   * [checkWriteStall] can force-close a client whose write never returns.
   */
  private inline fun trackingWriteStall(action: () -> Unit) {
    writeStartedAtMs = nowMs()
    try {
      action()
    } finally {
      writeStartedAtMs = NO_WRITE_IN_PROGRESS
    }
  }

  private fun replayCachedVideoLocked() {
    for (packet in packetCache.replay()) {
      writePacketDataLocked(
        TRACK_ID_VIDEO,
        VideoStreamProtocol.replayed(packet.ptsAndFlags),
        packet.data,
      )
    }
  }

  private fun writePacketDataLocked(trackId: Int, ptsAndFlags: Long, data: ByteArray): Boolean {
    if (stopped) return false

    // Keep the encoder alive during local client recovery. Video data is cached;
    // audio resumes live when the replacement mux client attaches.
    val output = outputStream ?: return true
    try {
      // One write per packet: header + payload are framed into a single buffer so each packet
      // costs one syscall instead of two and the header is never split from its payload across
      // TCP segments (issue #4743). Stamped for the write-stall watchdog (#4784) so a wedged
      // half-open transport is force-detached instead of orphaning the server.
      trackingWriteStall {
        output.write(VideoStreamProtocol.framedPacket(audioEnabled, trackId, ptsAndFlags, data))
      }
      return true
    } catch (e: IOException) {
      println("Error writing packet: ${e.message}")
      closeClientLocked()
      reconnectWindow.onClientDetached()
      return true
    }
  }

  private fun isCurrentClient(client: VideoClientConnection): Boolean =
    synchronized(lock) { clientSocket === client }

  private fun closeClientLocked() {
    try {
      outputStream?.close()
    } catch (_: IOException) {}
    try {
      clientSocket?.close()
    } catch (_: IOException) {}
    outputStream = null
    clientSocket = null
  }

  /** Stop the stream writer and close all sockets. */
  fun stop() {
    stopped = true
    handoff.close()
    // Unblock the writer thread if it is wedged in a blocking socket write (it holds `lock` for the
    // duration, so we must NOT take `lock` here). Closing the socket makes that write throw.
    try {
      clientSocket?.close()
    } catch (_: IOException) {}
    writerThread?.let {
      try {
        // Bounded: the socket close above unblocks a wedged write promptly; the join only lets the
        // writer thread unwind cleanly and must never hang shutdown.
        it.join(WRITER_JOIN_TIMEOUT_MS)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    writerThread = null
    // The watchdog only sleeps and reads volatiles; interrupt its sleep so it exits promptly.
    watchdogThread?.interrupt()
    watchdogThread = null
    synchronized(lock) {
      closeClientLocked()
    }
    try {
      serverSocket?.close()
    } catch (_: IOException) {}
    serverSocket = null
  }
}

/** Cached decoder setup and latest complete keyframe for a replacement client. */
internal data class CachedVideoPacket(val ptsAndFlags: Long, val data: ByteArray) {
  fun copyPacket(): CachedVideoPacket = CachedVideoPacket(ptsAndFlags, data.copyOf())
}

internal class VideoPacketCache {
  private var config: CachedVideoPacket? = null
  private var idr: CachedVideoPacket? = null

  fun remember(packet: CachedVideoPacket) {
    if ((packet.ptsAndFlags and VideoStreamProtocol.PACKET_FLAG_CONFIG) != 0L) {
      config = packet.copyPacket()
    }
    if ((packet.ptsAndFlags and VideoStreamProtocol.PACKET_FLAG_KEY_FRAME) != 0L) {
      idr = packet.copyPacket()
    }
  }

  /**
   * Drop the cached decoder state so the next [replay] starts empty. Used by the rotation-triggered
   * encoder swap (#4785): the old encoder's SPS/PPS + IDR describe the pre-rotation dimensions, so
   * they must not be replayed once a new encoder at the new dimensions is coming up. Clearing both
   * halves together (never one) keeps every [replay] snapshot self-consistent — a reconnecting
   * client can only ever see the old coherent pair, nothing, or the new coherent pair, never a new
   * SPS paired with the old IDR.
   */
  fun reset() {
    config = null
    idr = null
  }

  fun replay(): List<CachedVideoPacket> {
    val cachedConfig = config
    val cachedIdr = idr
    return when {
      cachedConfig == null && cachedIdr == null -> emptyList()
      cachedConfig == null -> listOfNotNull(cachedIdr).map(CachedVideoPacket::copyPacket)
      cachedIdr == null -> listOf(cachedConfig.copyPacket())
      cachedConfig.ptsAndFlags == cachedIdr.ptsAndFlags &&
        cachedConfig.data.contentEquals(cachedIdr.data) -> listOf(cachedConfig.copyPacket())
      else -> listOf(cachedConfig.copyPacket(), cachedIdr.copyPacket())
    }
  }
}
