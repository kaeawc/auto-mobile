package dev.jasonpearson.automobile.video

import android.media.MediaCodec
import android.os.SystemClock
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
  private val handoff = FrameHandoff()
  private val output = VideoClientOutput(VideoTransportOptions(width, height, audioEnabled), nowMs)
  internal val transport =
    VideoClientTransport(
      socketName,
      nowMs,
      socketFactory,
      handoff,
      output,
      VideoClientAdmission(socketName, expectedToken, nowMs),
    )

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

    /** Sentinel for [VideoClientOutput.writeStartedAtMs] when no client write is in flight. */
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

  /** Bind the socket and start transport workers; replay precedes each client callback. */
  fun start(onClientConnected: () -> Unit = {}) = transport.start(onClientConnected)

  /** Register the command callback for both the current client and future reconnects. */
  fun startCommandReader(onCommand: (Int) -> Unit) = transport.startCommandReader(onCommand)

  /** Cache decoder state and offer copied video to the non-blocking, drop-oldest handoff. */
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
    return offerEncoded(ptsAndFlags, data)
  }

  internal fun offerEncoded(ptsAndFlags: Long, data: ByteArray): Boolean {
    synchronized(output.lock) { output.packetCache.remember(CachedVideoPacket(ptsAndFlags, data)) }
    return handoff.offer(EncodedVideoFrame(ptsAndFlags, data))
  }

  fun writeAudioPacket(data: ByteArray, ptsUs: Long): Boolean =
    output.writePacket(TRACK_ID_AUDIO, ptsUs and PTS_MASK, data)

  /** Lock-free so a stalled transport write cannot prevent reconnect self-expiry. */
  fun reconnectWindowExpired(): Boolean = output.reconnectWindow.isExpired()

  internal fun consumeDropGap(): Boolean = handoff.consumeDropGap()

  internal fun droppedCount(): Long = handoff.droppedCount()

  /** Clear config and keyframe together under the attachment lock before a rotation swap. */
  fun resetReplayCacheForResize() {
    synchronized(output.lock) { output.packetCache.reset() }
  }

  /** Close the handoff and sockets, then give the transport writer bounded time to exit. */
  fun stop() = transport.stop()
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
