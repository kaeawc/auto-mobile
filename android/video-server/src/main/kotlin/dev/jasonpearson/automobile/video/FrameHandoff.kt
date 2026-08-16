package dev.jasonpearson.automobile.video

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** One encoded H.264 access unit copied out of the MediaCodec output buffer. */
class EncodedVideoFrame(val ptsAndFlags: Long, val data: ByteArray) {
  /** SPS/PPS codec configuration (bit 63). */
  val isConfig: Boolean
    get() = (ptsAndFlags and VideoStreamProtocol.PACKET_FLAG_CONFIG) != 0L

  /** IDR / sync frame (bit 62). */
  val isKeyFrame: Boolean
    get() = (ptsAndFlags and VideoStreamProtocol.PACKET_FLAG_KEY_FRAME) != 0L

  /**
   * Config and keyframes are decoder-essential: a delta frame is undecodable without the reference
   * IDR (and the IDR without its SPS/PPS), so these must not be silently discarded from the live
   * path.
   */
  val isCritical: Boolean
    get() = isConfig || isKeyFrame
}

/**
 * A single-slot, drop-oldest handoff that decouples the MediaCodec encode loop from the transport
 * writer thread (issue #4749).
 *
 * The encode loop must never block on a slow or stalled socket reader. A synchronous `dequeue ->
 * blocking write -> release` loop lets transport back-pressure the encoder: unreleased output
 * buffers stall MediaCodec's Surface input, so frames are delayed instead of dropped. This handoff
 * holds at most one pending packet. A newer delta replaces an unsent older one (latest-frame-wins)
 * so the reader always advances toward the live edge rather than draining a stale backlog.
 *
 * ## Keyframe / config protection
 *
 * A slotted config or keyframe is **sticky**: while one occupies the slot every subsequent offer is
 * dropped until the writer takes it. This guarantees that any decoder-essential packet that reaches
 * the slot is delivered intact and in order (SPS/PPS before its IDR), and can never be buried by a
 * later delta that the decoder could not use anyway. Criticals arrive when the slot is idle (config
 * at startup; IDRs on the 2s GOP boundary or a keyframe request), so stickiness costs nothing in
 * the steady state. The reconnect cache in [VideoStreamWriter] independently retains SPS/PPS + the
 * latest IDR for replacement-client replay, so nothing the handoff drops compromises reconnect.
 *
 * Pure JVM: no Android framework, no wall-clock or real timers, so the drop policy unit-tests
 * deterministically.
 */
class FrameHandoff {
  private val lock = ReentrantLock()
  private val available = lock.newCondition()
  private var slot: EncodedVideoFrame? = null
  private var closed = false
  private var dropped = 0L

  /**
   * Offer an encoded packet to the writer. Never blocks the caller (the encode loop).
   *
   * @return false once the handoff is [close]d (the producer should stop), true otherwise.
   */
  fun offer(frame: EncodedVideoFrame): Boolean = lock.withLock {
    if (closed) {
      return false
    }
    val existing = slot
    when {
      existing == null -> slot = frame
      existing.isCritical -> {
        // Sticky critical: never overwrite an unsent config/keyframe. Drop the newcomer;
        // the encoder re-emits an IDR on the next GOP boundary or keyframe request.
        dropped++
        return true
      }
      else -> {
        // Slot holds a delta; the newer packet supersedes it (drop-oldest / latest-wins).
        dropped++
        slot = frame
      }
    }
    available.signalAll()
    true
  }

  /**
   * Block until a packet is available or the handoff is closed, then remove and return it. Returns
   * null only when the handoff is closed and drained, signalling the writer thread to exit.
   */
  fun take(): EncodedVideoFrame? = lock.withLock {
    while (slot == null && !closed) {
      available.await()
    }
    val frame = slot
    slot = null
    frame
  }

  /** Non-blocking variant of [take]; returns null when the slot is empty. */
  fun poll(): EncodedVideoFrame? = lock.withLock {
    val frame = slot
    slot = null
    frame
  }

  /** Close the handoff, waking any blocked [take] so the writer thread can exit. */
  fun close() {
    lock.withLock {
      closed = true
      available.signalAll()
    }
  }

  /** Total packets discarded by the drop-oldest policy since construction. */
  fun droppedCount(): Long = lock.withLock { dropped }

  /** The currently-slotted packet without removing it; for tests and diagnostics. */
  fun peek(): EncodedVideoFrame? = lock.withLock { slot }
}
