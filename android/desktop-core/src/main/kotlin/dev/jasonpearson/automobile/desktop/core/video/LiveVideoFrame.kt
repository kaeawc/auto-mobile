package dev.jasonpearson.automobile.desktop.core.video

import androidx.compose.ui.graphics.ImageBitmap

/**
 * A decoded live-mirror frame together with the provenance needed to tell a *live* frame from a
 * *frozen* one (issue #3348).
 *
 * When the relay stalls with its socket open, the stream client keeps reporting `Streaming` and
 * keeps its last bitmap: dimensions, state and pixels all stay put, so nothing about the frame
 * itself reveals that it stopped advancing. [sequence] and [receivedAtMs] are stamped by the client
 * as each frame is decoded, so a recency bound on [receivedAtMs] retires a frozen mirror and drops
 * device control. This is a contained provenance signal — it adds no coupling to the stream
 * client's internals or its backpressure behavior.
 */
data class LiveVideoFrame(
  val bitmap: ImageBitmap,
  val sequence: Long,
  val receivedAtMs: Long,
  /**
   * Per-frame display rotation; absent until the relay protocol can attest it, so control fails
   * closed.
   */
  val rotation: Int? = null,
)
