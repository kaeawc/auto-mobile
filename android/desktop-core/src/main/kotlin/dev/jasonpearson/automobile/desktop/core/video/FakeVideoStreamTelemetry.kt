package dev.jasonpearson.automobile.desktop.core.video

import androidx.compose.ui.graphics.ImageBitmap
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/** Frame and relay-activity controls shared by the in-memory stream source. */
abstract class FakeVideoStreamTelemetry(private val nowMs: () -> Long) : VideoStreamSource {
  private val fakeSequence = java.util.concurrent.atomic.AtomicLong(0L)

  private val _frames =
    MutableSharedFlow<LiveVideoFrame>(
      replay = 1,
      extraBufferCapacity = 2,
      onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
  override val frames: SharedFlow<LiveVideoFrame> = _frames.asSharedFlow()
  private val _emittedFrameSequence = MutableStateFlow(0L)
  override val emittedFrameSequence: StateFlow<Long> = _emittedFrameSequence.asStateFlow()
  private val _droppedFrames = MutableSharedFlow<Long>(replay = 1, extraBufferCapacity = 1)
  override val droppedFrames: SharedFlow<Long> = _droppedFrames.asSharedFlow()

  private val _heartbeatMs = MutableStateFlow<Long?>(null)
  override val heartbeatMs: StateFlow<Long?> = _heartbeatMs.asStateFlow()
  private val _lastActivityMs = MutableStateFlow(0L)
  override val lastActivityMs: StateFlow<Long> = _lastActivityMs.asStateFlow()

  /** Publishes a ready-to-draw frame to collectors, as the real client would. */
  fun emitFrame(
    width: Int = 1080,
    height: Int = 2400,
    rotation: Int? = null,
  ) {
    val sequence = fakeSequence.incrementAndGet()
    _frames.tryEmit(
      LiveVideoFrame(
        bitmap = ImageBitmap(width, height),
        sequence = sequence,
        receivedAtMs = nowMs(),
        rotation = rotation,
      ),
    )
    _emittedFrameSequence.value = sequence
  }

  /** Records a decoded frame without allocating a native bitmap in virtual-time policy tests. */
  fun recordFrameEmission() {
    _emittedFrameSequence.value = fakeSequence.incrementAndGet()
  }

  /** Publishes source-side encoder-drop telemetry for quality-controller tests. */
  fun emitDroppedFrames(droppedFrames: Long) {
    _droppedFrames.tryEmit(droppedFrames)
  }

  /**
   * Sets the advertised heartbeat cadence, as a real ack would report after connect (issue #7549).
   * Null (the default) models a daemon that predates the field.
   */
  fun setHeartbeatMs(heartbeatMs: Long?) {
    _heartbeatMs.value = heartbeatMs
  }

  /**
   * Simulates a relay heartbeat: bumps [lastActivityMs] with no accompanying frame, so a test can
   * drive the Streaming-stall watchdog's heartbeat-progress path for a source with no idle frames
   * of its own (issue #7549).
   */
  fun emitHeartbeat() {
    _lastActivityMs.value = nowMs()
  }

  /** Models the real reader's per-session activity reset during a reconnect. */
  fun resetActivity() {
    _lastActivityMs.value = 0L
  }
}
