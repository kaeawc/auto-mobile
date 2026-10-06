package dev.jasonpearson.automobile.sdk.network

import java.io.IOException
import java.nio.charset.Charset
import okhttp3.MediaType
import okhttp3.RequestBody
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.Sink
import okio.Timeout
import okio.buffer

/**
 * Body capture primitives for [AutoMobileNetworkInterceptor].
 *
 * The SDK runs inside the host app, so capture must never change what the app sends or receives and
 * must never block or exhaust memory: request bodies are only written twice when that is safe and
 * then through a size-capped sink; response bytes are copied as the app reads them instead of being
 * pre-read on the interceptor thread.
 */
internal object NetworkBodyCapture {
  /**
   * How long a response capture waits for the app to finish (exhaust or close) the body before
   * emitting what was captured so far. Bounds the lifetime of an abandoned, never-closed body.
   */
  const val RESPONSE_CAPTURE_DEADLINE_MS = 30_000L

  /**
   * Streaming content types are never captured: their body is open-ended by definition, so the
   * event would otherwise only be emitted at the deadline or on close.
   */
  fun isStreamingContentType(contentType: String?): Boolean =
    contentType?.substringBefore(';')?.trim()?.lowercase() == "text/event-stream"

  /**
   * Capture at most [maxBytes] of [body] as UTF-8, or null when the body must not be touched.
   *
   * A body that is one-shot (can be written once) or duplex (its write can block on the response)
   * is never written by the SDK. A body whose length is known to exceed [maxBytes] is skipped
   * outright. Anything else is written through a sink that stops accepting bytes at the cap, so the
   * SDK never holds, or pulls from the app's body, more than about the cap.
   */
  fun captureRequestBody(body: RequestBody, maxBytes: Long): String? {
    if (body.isOneShot() || body.isDuplex()) return null
    if (body.contentLength() > maxBytes) return null
    val cap = CappedSink(maxBytes)
    val sink = cap.buffer()
    try {
      body.writeTo(sink)
      sink.flush()
    } catch (_: CaptureLimitReached) {
      // Expected: the body is larger than the cap; the captured prefix is what we keep.
    } catch (_: IOException) {
      return null
    }
    return cap.captured.readUtf8()
  }

  /** Thrown by [CappedSink] to stop the body's write once the cap is full. */
  private class CaptureLimitReached : IOException("capture limit reached")

  private class CappedSink(private val maxBytes: Long) : Sink {
    val captured = Buffer()

    override fun write(source: Buffer, byteCount: Long) {
      val room = maxBytes - captured.size
      val keep = minOf(byteCount, room)
      if (keep > 0) captured.write(source, keep)
      source.skip(byteCount - keep)
      if (captured.size >= maxBytes) throw CaptureLimitReached()
    }

    override fun flush() = Unit

    override fun timeout(): Timeout = Timeout.NONE

    override fun close() = Unit
  }

  /**
   * Wraps a response body so that up to [maxBytes] are copied as the app reads them. Construction
   * and [source] never read from the network. [onComplete] is invoked exactly once with the
   * captured text when the body is exhausted, fails, is closed, reaches the cap, or the deadline
   * passes, whichever comes first.
   */
  class CapturingResponseBody(
    private val delegate: ResponseBody,
    private val maxBytes: Long,
    private val onComplete: (String) -> Unit,
    scheduleDeadline: (Runnable, Long) -> (() -> Unit)?,
    deadlineMs: Long = RESPONSE_CAPTURE_DEADLINE_MS,
  ) : ResponseBody() {
    private val charset: Charset = delegate.contentType().charsetOrUtf8()
    private val captured = Buffer()
    private var finished = false
    private var cancelDeadline: (() -> Unit)? = null
    private val capturingSource: BufferedSource = CapturingSource(delegate.source()).buffer()

    init {
      val cancel = scheduleDeadline(Runnable { complete() }, deadlineMs)
      synchronized(this) { if (finished) cancel?.invoke() else cancelDeadline = cancel }
    }

    override fun contentType(): MediaType? = delegate.contentType()

    override fun contentLength(): Long = delegate.contentLength()

    override fun source(): BufferedSource = capturingSource

    private fun record(sink: Buffer, readBytes: Long) {
      val full =
        synchronized(this) {
          if (finished) return
          val room = maxBytes - captured.size
          if (room > 0) sink.copyTo(captured, sink.size - readBytes, minOf(readBytes, room))
          captured.size >= maxBytes
        }
      if (full) complete()
    }

    private fun complete() {
      val text: String
      val cancel: (() -> Unit)?
      synchronized(this) {
        if (finished) return
        finished = true
        text = String(captured.readByteArray(), charset)
        cancel = cancelDeadline
        cancelDeadline = null
      }
      cancel?.invoke()
      onComplete(text)
    }

    private inner class CapturingSource(delegate: okio.Source) : ForwardingSource(delegate) {
      override fun read(sink: Buffer, byteCount: Long): Long {
        val read =
          try {
            super.read(sink, byteCount)
          } catch (error: IOException) {
            complete()
            throw error
          }
        if (read == -1L) complete() else record(sink, read)
        return read
      }

      override fun close() {
        try {
          complete()
        } finally {
          super.close()
        }
      }
    }
  }

  private fun MediaType?.charsetOrUtf8(): Charset = this?.charset(Charsets.UTF_8) ?: Charsets.UTF_8
}
