package dev.jasonpearson.automobile.desktop.core.video

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Covers the client half of the daemon's binary video framing.
 *
 * The encoder lives in `src/daemon/videoStreamFraming.ts`; these tests build bytes the same way it
 * does, so a drift on either side shows up here.
 */
class VideoStreamParserTest {

  private fun streamHeader(width: Int = 0, height: Int = 0): ByteArray =
    ByteBuffer.allocate(12)
      .order(ByteOrder.BIG_ENDIAN)
      .putInt(CODEC_ID_H264)
      .putInt(width)
      .putInt(height)
      .array()

  private fun packet(
    payload: ByteArray,
    ptsUs: Long = 0,
    isConfig: Boolean = false,
    isKeyFrame: Boolean = false,
    rotation: Int? = null,
  ): ByteArray {
    var ptsAndFlags = ptsUs and ((1L shl 59) - 1)
    if (isConfig) ptsAndFlags = ptsAndFlags or (1L shl 63)
    if (isKeyFrame) ptsAndFlags = ptsAndFlags or (1L shl 62)
    // Rotation rides bit 61 (ROTATION_PRESENT) + bits 59-60, matching videoStreamFraming.ts.
    if (rotation != null) {
      ptsAndFlags = ptsAndFlags or (1L shl 61)
      ptsAndFlags = ptsAndFlags or ((rotation.toLong() and 0b11L) shl 59)
    }
    return ByteBuffer.allocate(12 + payload.size)
      .order(ByteOrder.BIG_ENDIAN)
      .putLong(ptsAndFlags)
      .putInt(payload.size)
      .put(payload)
      .array()
  }

  private class Collected {
    val headers = mutableListOf<VideoStreamHeader>()
    val packets = mutableListOf<VideoPacket>()
  }

  private fun feed(parser: VideoStreamParser, vararg chunks: ByteArray): Collected {
    val out = Collected()
    chunks.forEach { parser.onBytes(it, out.headers::add, out.packets::add) }
    return out
  }

  @Test
  fun `honors length and ignores stale bytes past it in a reused buffer`() {
    // The reader hands its fixed 64KB buffer with only `read` bytes valid; the rest is last read's
    // stale data. The parser must treat only the first `length` bytes as live.
    val valid = streamHeader(720, 1280) + packet(byteArrayOf(9, 8, 7))
    val reused = valid + ByteArray(64) { 0x5a } // trailing garbage that must never be parsed
    val out = Collected()

    VideoStreamParser().onBytes(reused, valid.size, out.headers::add, out.packets::add)

    assertEquals(listOf(VideoStreamHeader(720, 1280)), out.headers)
    assertEquals(1, out.packets.size)
    assertContentEquals(byteArrayOf(9, 8, 7), out.packets[0].payload)
  }

  @Test
  fun `a partial packet within length is buffered and completed on the next feed`() {
    val parser = VideoStreamParser()
    val whole = streamHeader() + packet(byteArrayOf(1, 2, 3, 4))
    val out = Collected()
    // First feed carries the header plus only part of the packet (valid length stops mid-payload);
    // the trailing bytes of the reused buffer are the rest but must be ignored until fed as live.
    val firstValid = whole.size - 2
    parser.onBytes(whole, firstValid, out.headers::add, out.packets::add)
    assertEquals(1, out.headers.size)
    assertTrue(out.packets.isEmpty())

    // Feed the final 2 bytes as their own live chunk; the buffered remainder completes the packet.
    parser.onBytes(whole.copyOfRange(firstValid, whole.size), 2, out.headers::add, out.packets::add)
    assertEquals(1, out.packets.size)
    assertContentEquals(byteArrayOf(1, 2, 3, 4), out.packets[0].payload)
  }

  @Test
  fun `reads the stream header then packets`() {
    val out =
      feed(
        VideoStreamParser(),
        streamHeader(1080, 2400) + packet(byteArrayOf(1, 2, 3)) + packet(byteArrayOf(4, 5)),
      )

    assertEquals(listOf(VideoStreamHeader(1080, 2400)), out.headers)
    assertEquals(2, out.packets.size)
    assertContentEquals(byteArrayOf(1, 2, 3), out.packets[0].payload)
    assertContentEquals(byteArrayOf(4, 5), out.packets[1].payload)
  }

  @Test
  fun `zero dimensions are reported as-is rather than guessed`() {
    // The daemon sends 0x0 unless the client passed a size hint; the true size comes from the SPS.
    val out = feed(VideoStreamParser(), streamHeader())

    assertEquals(listOf(VideoStreamHeader(0, 0)), out.headers)
  }

  @Test
  fun `config and key-frame flags survive the round trip`() {
    val out =
      feed(
        VideoStreamParser(),
        streamHeader() +
          packet(byteArrayOf(7), ptsUs = 1234, isConfig = true) +
          packet(byteArrayOf(5), ptsUs = 5678, isKeyFrame = true),
      )

    assertTrue(out.packets[0].isConfig)
    assertTrue(!out.packets[0].isKeyFrame)
    assertEquals(1234L, out.packets[0].presentationTimeUs)

    assertTrue(out.packets[1].isKeyFrame)
    assertTrue(!out.packets[1].isConfig)
    assertEquals(5678L, out.packets[1].presentationTimeUs)
  }

  @Test
  fun `the config flag does not corrupt the timestamp`() {
    // Bit 63 makes the int64 negative; a parser that forgets to mask reads a nonsense pts.
    val out =
      feed(VideoStreamParser(), streamHeader() + packet(byteArrayOf(1), 999, isConfig = true))

    assertEquals(999L, out.packets.single().presentationTimeUs)
    assertTrue(out.packets.single().presentationTimeUs > 0)
  }

  @Test
  fun `a stream split byte by byte parses identically`() {
    val whole = streamHeader(720, 1280) + packet(byteArrayOf(1, 2, 3, 4)) + packet(byteArrayOf(9))

    val parser = VideoStreamParser()
    val out = Collected()
    whole.forEach { parser.onBytes(byteArrayOf(it), out.headers::add, out.packets::add) }

    assertEquals(listOf(VideoStreamHeader(720, 1280)), out.headers)
    assertEquals(2, out.packets.size)
    assertContentEquals(byteArrayOf(1, 2, 3, 4), out.packets[0].payload)
    assertContentEquals(byteArrayOf(9), out.packets[1].payload)
  }

  @Test
  fun `a header split across reads is not lost`() {
    val header = streamHeader(1, 2)
    val out =
      feed(
        VideoStreamParser(),
        header.copyOfRange(0, 5),
        header.copyOfRange(5, 12) + packet(byteArrayOf(1)),
      )

    assertEquals(listOf(VideoStreamHeader(1, 2)), out.headers)
    assertEquals(1, out.packets.size)
  }

  @Test
  fun `a payload split across reads is buffered until complete`() {
    val full = streamHeader() + packet(ByteArray(100) { it.toByte() })

    val out = feed(VideoStreamParser(), full.copyOfRange(0, 40), full.copyOfRange(40, full.size))

    assertEquals(1, out.packets.size)
    assertEquals(100, out.packets.single().payload.size)
  }

  @Test
  fun `a partial trailing packet emits nothing until the rest arrives`() {
    val full = streamHeader() + packet(byteArrayOf(1, 2, 3))
    val parser = VideoStreamParser()

    val partial = feed(parser, full.copyOfRange(0, full.size - 1))
    assertTrue(partial.packets.isEmpty(), "an incomplete packet must not be emitted")

    val rest = feed(parser, full.copyOfRange(full.size - 1, full.size))
    assertEquals(1, rest.packets.size)
  }

  @Test
  fun `an empty chunk is a no-op`() {
    val out = feed(VideoStreamParser(), ByteArray(0))

    assertTrue(out.headers.isEmpty())
    assertTrue(out.packets.isEmpty())
  }

  @Test
  fun `a zero-length packet is allowed and yields an empty payload`() {
    val out = feed(VideoStreamParser(), streamHeader() + packet(ByteArray(0)))

    assertEquals(1, out.packets.size)
    assertEquals(0, out.packets.single().payload.size)
  }

  @Test
  fun `a foreign codec id is rejected by name`() {
    val foreign =
      ByteBuffer.allocate(12)
        .order(ByteOrder.BIG_ENDIAN)
        .putInt(0x616d7578)
        .putInt(1)
        .putInt(1)
        .array()

    val failure =
      assertFailsWith<VideoStreamFormatException> {
        feed(VideoStreamParser(), foreign)
      }

    // 0x616d7578 is "amux", the daemon's audio-muxed variant, which this client does not decode.
    assertTrue(failure.message!!.contains("616d7578"), failure.message!!)
  }

  @Test
  fun `decodes the attested rotation from a config packet for every value`() {
    for (rotation in 0..3) {
      val out =
        feed(
          VideoStreamParser(),
          streamHeader() +
            packet(byteArrayOf(0x67.toByte()), 4242, isConfig = true, rotation = rotation),
        )

      assertEquals(rotation, out.packets.single().rotation)
      // The rotation bits must not leak into the timestamp.
      assertEquals(4242L, out.packets.single().presentationTimeUs)
    }
  }

  @Test
  fun `rotation is null when the presence bit is absent`() {
    // A config packet from a relay whose source could not attest rotation leaves rotation unknown.
    val out =
      feed(
        VideoStreamParser(),
        streamHeader() + packet(byteArrayOf(0x67.toByte()), 5, isConfig = true),
      )

    assertTrue(out.packets.single().isConfig)
    assertEquals(null, out.packets.single().rotation)
  }

  @Test
  fun `rotation is null on a non-config packet even when the presence bit is set`() {
    // Only a config packet attests rotation; the parser must not read it off a key frame.
    val out =
      feed(
        VideoStreamParser(),
        streamHeader() + packet(byteArrayOf(0x65.toByte()), 9, isKeyFrame = true, rotation = 2),
      )

    assertTrue(out.packets.single().isKeyFrame)
    assertEquals(null, out.packets.single().rotation)
  }

  @Test
  fun `many packets in one read are all emitted`() {
    val chunk =
      streamHeader() +
        (0 until 50).fold(ByteArray(0)) { acc, i -> acc + packet(byteArrayOf(i.toByte())) }

    val out = feed(VideoStreamParser(), chunk)

    assertEquals(50, out.packets.size)
    assertEquals(49, out.packets.last().payload.single().toInt())
  }
}
