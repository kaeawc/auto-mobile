package dev.jasonpearson.automobile.desktop.core.video

import org.bytedeco.ffmpeg.avcodec.AVCodecContext
import org.bytedeco.ffmpeg.avcodec.AVCodecParserContext
import org.bytedeco.ffmpeg.avcodec.AVPacket
import org.bytedeco.ffmpeg.avutil.AVFrame
import org.bytedeco.ffmpeg.global.avcodec
import org.bytedeco.ffmpeg.global.avutil
import org.bytedeco.ffmpeg.global.swscale
import org.bytedeco.ffmpeg.swscale.SwsContext
import org.bytedeco.javacpp.BytePointer
import org.bytedeco.javacpp.IntPointer
import org.bytedeco.javacpp.PointerPointer

/**
 * One decoded frame as tightly packed BGRA, ready to hand to Skia.
 *
 * [rotation] is the display rotation (`0..3`) attested by the most recent CONFIG packet, or null
 * when unknown (issue #4786). The decoder itself cannot know it — [VideoStreamClient] stamps it
 * from the stream's config packets — so it defaults to null for frames the decoder constructs.
 */
class DecodedFrame(
  val width: Int,
  val height: Int,
  val bgra: ByteArray,
  val rotation: Int? = null,
)

/** Raised when the decoder cannot be created or a decode step fails unrecoverably. */
class H264DecodeException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Decodes a raw H.264 Annex-B elementary stream into BGRA frames.
 *
 * Chunks arrive from the daemon's `video-stream.sock` relay in whatever sizes the capture source
 * produced, so they do not align to frame boundaries. An `AVCodecParserContext` reassembles access
 * units before they reach the decoder, which is why callers can feed bytes as they arrive rather
 * than having to split frames themselves.
 *
 * Not thread-safe: feed it from a single reader. All native memory is released by [close]; the
 * scaler is allocated lazily because the frame size is only known once the first frame decodes (the
 * stream header's dimensions are advisory, and zero unless the client sent a hint).
 */
class H264Decoder : AutoCloseable {
  private val codec =
    avcodec.avcodec_find_decoder(avcodec.AV_CODEC_ID_H264)
      ?: throw H264DecodeException("This ffmpeg build has no H.264 decoder")

  private val context: AVCodecContext =
    avcodec.avcodec_alloc_context3(codec)
      ?: throw H264DecodeException("Could not allocate an H.264 decoder context")

  private val parser: AVCodecParserContext =
    avcodec.av_parser_init(codec.id())
      ?: throw H264DecodeException("Could not initialise the H.264 parser")

  private val packet: AVPacket = avcodec.av_packet_alloc()
  private val frame: AVFrame = avutil.av_frame_alloc()
  private val bgraFrame: AVFrame = avutil.av_frame_alloc()

  private var scaler: SwsContext? = null
  private var scaledWidth = 0
  private var scaledHeight = 0
  private var closed = false

  // Reused across frames (reallocated only on a size change) so a long-running stream
  // allocates nothing per frame — this is why DecodedFrame is only valid during onFrame.
  private var out = ByteArray(0)

  init {
    if (avcodec.avcodec_open2(context, codec, null as PointerPointer<*>?) < 0) {
      close()
      throw H264DecodeException("Could not open the H.264 decoder")
    }
  }

  /**
   * Feeds one chunk of the elementary stream, invoking [onFrame] for every complete frame it yields
   * — which may be none (the chunk was partial) or several.
   *
   * The [DecodedFrame] passed to [onFrame] is only valid for the duration of the call; its buffer
   * is reused. Copy it if you need to retain it.
   */
  fun decode(chunk: ByteArray, onFrame: (DecodedFrame) -> Unit) {
    check(!closed) { "Decoder is closed" }
    if (chunk.isEmpty()) return

    val input = BytePointer(*chunk)
    // The parser writes the assembled access unit back through these out-params.
    val outData = PointerPointer<BytePointer>(1L)
    val outSize = IntPointer(1L)

    try {
      var offset = 0
      while (offset < chunk.size) {
        val consumed =
          avcodec.av_parser_parse2(
            parser,
            context,
            outData,
            outSize,
            input.position(offset.toLong()),
            chunk.size - offset,
            avutil.AV_NOPTS_VALUE,
            avutil.AV_NOPTS_VALUE,
            0L,
          )
        if (consumed < 0) {
          throw H264DecodeException("H.264 parser rejected the stream")
        }
        offset += consumed

        // The parser buffers until it holds a whole access unit; size 0 means it wants more bytes.
        val size = outSize.get()
        if (size > 0) {
          packet.data(outData.get(BytePointer::class.java, 0))
          packet.size(size)
          drainPacket(onFrame)
        }
        if (consumed == 0 && size == 0) {
          // No progress and nothing emitted: the remainder is a partial access unit.
          break
        }
      }
    } finally {
      outSize.deallocate()
      outData.deallocate()
      input.deallocate()
    }
  }

  private fun drainPacket(onFrame: (DecodedFrame) -> Unit) {
    if (avcodec.avcodec_send_packet(context, packet) < 0) {
      // A rejected packet is recoverable -- the next key frame resynchronises -- so this is not
      // fatal to the stream.
      return
    }
    while (true) {
      val result = avcodec.avcodec_receive_frame(context, frame)
      if (result != 0) {
        // EAGAIN (needs more input) and EOF are both normal loop exits.
        return
      }
      onFrame(toBgra(frame))
    }
  }

  private fun toBgra(source: AVFrame): DecodedFrame {
    val width = source.width()
    val height = source.height()
    if (width <= 0 || height <= 0) {
      throw H264DecodeException("Decoder produced a frame with no dimensions")
    }

    if (scaler == null || width != scaledWidth || height != scaledHeight) {
      // Device rotation changes the frame size mid-stream, so the scaler is rebuilt rather than
      // assumed constant.
      scaler?.let { swscale.sws_freeContext(it) }
      scaler =
        swscale.sws_getContext(
          width,
          height,
          source.format(),
          width,
          height,
          avutil.AV_PIX_FMT_BGRA,
          swscale.SWS_BILINEAR,
          null,
          null,
          null as java.nio.DoubleBuffer?,
        ) ?: throw H264DecodeException("Could not create the BGRA scaler")
      scaledWidth = width
      scaledHeight = height

      avutil.av_frame_unref(bgraFrame)
      bgraFrame.format(avutil.AV_PIX_FMT_BGRA)
      bgraFrame.width(width)
      bgraFrame.height(height)
      if (avutil.av_frame_get_buffer(bgraFrame, 0) < 0) {
        throw H264DecodeException("Could not allocate a BGRA frame buffer")
      }
    }

    swscale.sws_scale(
      scaler,
      source.data(),
      source.linesize(),
      0,
      height,
      bgraFrame.data(),
      bgraFrame.linesize(),
    )

    val stride = bgraFrame.linesize(0)
    val rowBytes = width * 4
    if (out.size != rowBytes * height) {
      out = ByteArray(rowBytes * height)
    }
    val plane = bgraFrame.data(0)
    if (stride == rowBytes) {
      plane.position(0).get(out, 0, out.size)
    } else {
      // swscale pads rows for alignment; Skia wants them tightly packed.
      for (row in 0 until height) {
        plane.position((row.toLong() * stride)).get(out, row * rowBytes, rowBytes)
      }
    }
    plane.position(0)

    return DecodedFrame(width, height, out)
  }

  override fun close() {
    if (closed) return
    closed = true
    scaler?.let { swscale.sws_freeContext(it) }
    scaler = null
    avutil.av_frame_free(bgraFrame)
    avutil.av_frame_free(frame)
    avcodec.av_packet_free(packet)
    avcodec.av_parser_close(parser)
    avcodec.avcodec_free_context(context)
  }
}
