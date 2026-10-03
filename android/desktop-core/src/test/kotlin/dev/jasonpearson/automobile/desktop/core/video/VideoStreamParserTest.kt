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

  // Packet layout: 12-byte header, int64 BE ptsAndFlags then int32 BE length.
  // A notice is (flag bit 61 | code), length 0; no video payload follows it.
  private fun notice(code: Long): ByteArray =
    ByteBuffer.allocate(12)
      .order(ByteOrder.BIG_ENDIAN)
      .putLong((1L shl 61) or code)
      .putInt(0)
      .array()

  private fun sampleH264(): ByteArray =
    checkNotNull(javaClass.classLoader.getResourceAsStream("sample.h264")).use { it.readBytes() }

  private fun assertNotice(code: Long, expected: VideoStreamNotice) {
    val parser = VideoStreamParser()
    val notices = mutableListOf<VideoStreamNotice>()
    val packets = mutableListOf<VideoPacket>()
    parser.onBytes(
      streamHeader() + notice(code),
      onHeader = {},
      onPacket = packets::add,
      onNotice = notices::add,
    )
    assertEquals(listOf(expected), notices)
    assertTrue(packets.isEmpty())
    assertEquals(expected is VideoStreamNotice.Ended, parser.hasEnded)
  }

  @Test fun `code 1 downgrades to viewer`() = assertNotice(1, VideoStreamNotice.Downgraded)

  @Test
  fun `code 2 ends on device removal`() =
    assertNotice(2, VideoStreamNotice.Ended(VideoStreamEndReason.DeviceRemoved))

  @Test
  fun `code 3 ends on identity quarantine`() =
    assertNotice(3, VideoStreamNotice.Ended(VideoStreamEndReason.IdentityQuarantined))

  @Test
  fun `code 4 ends on daemon shutdown`() =
    assertNotice(4, VideoStreamNotice.Ended(VideoStreamEndReason.DaemonShutdown))

  @Test
  fun `code 5 ends on session ending`() =
    assertNotice(5, VideoStreamNotice.Ended(VideoStreamEndReason.SessionEnded))

  @Test
  fun `code 6 ends on device restoration`() =
    assertNotice(6, VideoStreamNotice.Ended(VideoStreamEndReason.DeviceRestored))

  @Test
  fun `unknown notice is typed and does not end or emit video`() =
    assertNotice(99, VideoStreamNotice.Unknown(99))

  @Test
  fun `downgrade between captured frames preserves ordering across split reads`() {
    val video = sampleH264()
    val first = packet(video, ptsUs = 1, isKeyFrame = true)
    val last = packet(video, ptsUs = 2)
    val bytes = streamHeader() + first + notice(1) + last
    val split = 12 + first.size + 7
    val parser = VideoStreamParser()
    val events = mutableListOf<Any>()
    for (chunk in listOf(bytes.copyOfRange(0, split), bytes.copyOfRange(split, bytes.size))) {
      parser.onBytes(chunk, onHeader = {}, onPacket = events::add, onNotice = events::add)
    }
    assertEquals(
      listOf(
        VideoPacket(video, 1, false, true),
        VideoStreamNotice.Downgraded,
        VideoPacket(video, 2, false, false),
      ),
      events,
    )
    assertTrue(!parser.hasEnded)
  }

  private fun assertTerminalTail(byteByByte: Boolean) {
    val line =
      """{"type":"video_stream_response","terminal":true,"reason":"session_ended"}
"""
        .toByteArray()
    val bytes = streamHeader() + notice(5) + line
    val parser = VideoStreamParser()
    val notices = mutableListOf<VideoStreamNotice>()
    val packets = mutableListOf<VideoPacket>()
    val chunks = if (byteByByte) bytes.map { byteArrayOf(it) } else listOf(bytes)
    for (chunk in chunks) {
      parser.onBytes(chunk, onHeader = {}, onPacket = packets::add, onNotice = notices::add)
    }
    // EOF supplies no additional bytes. JSON must never be decoded as a binary packet header.
    parser.onBytes(byteArrayOf(), onHeader = {}, onPacket = packets::add, onNotice = notices::add)
    assertTrue(parser.hasEnded)
    assertContentEquals(line, parser.trailingBytes)
    assertEquals(
      listOf<VideoStreamNotice>(VideoStreamNotice.Ended(VideoStreamEndReason.SessionEnded)),
      notices,
    )
    assertTrue(packets.isEmpty())
  }

  @Test
  fun `end notice retains terminal JSON instead of parsing it as binary`() =
    assertTerminalTail(false)

  @Test
  fun `end notice and terminal JSON fed byte by byte retain identical tail`() =
    assertTerminalTail(true)

  @Test
  fun `rotation config key and nonempty P frames are never notices`() {
    val video = sampleH264()
    val packets = mutableListOf<VideoPacket>()
    val notices = mutableListOf<VideoStreamNotice>()
    VideoStreamParser()
      .onBytes(
        streamHeader() +
          packet(video, isConfig = true, rotation = 0) +
          packet(video, isKeyFrame = true, rotation = 0) +
          packet(video, rotation = 0),
        onHeader = {},
        onPacket = packets::add,
        onNotice = notices::add,
      )
    assertEquals(3, packets.size)
    packets.forEach { assertContentEquals(video, it.payload) }
    assertEquals(0, packets.first().rotation)
    assertTrue(notices.isEmpty())
  }

  @Test
  fun `heartbeat drops and empty key or config with bit 61 are not notices`() {
    val packets = mutableListOf<VideoPacket>()
    val notices = mutableListOf<VideoStreamNotice>()
    val flags =
      listOf(
        (1L shl 60),
        (1L shl 59) or 7,
        (1L shl 63) or (1L shl 61),
        (1L shl 62) or (1L shl 61),
        (1L shl 60) or (1L shl 61),
        (1L shl 59) or (1L shl 61) or 7,
      )
    val bytes =
      flags.fold(streamHeader()) { acc, flag ->
        acc + ByteBuffer.allocate(12).order(ByteOrder.BIG_ENDIAN).putLong(flag).putInt(0).array()
      }
    VideoStreamParser()
      .onBytes(bytes, onHeader = {}, onPacket = packets::add, onNotice = notices::add)
    assertEquals(6, packets.size)
    assertTrue(packets[0].heartbeat)
    assertEquals(7L, packets[1].droppedFrames)
    assertTrue(packets[4].heartbeat)
    assertEquals(7L, packets[5].droppedFrames)
    assertTrue(notices.isEmpty())
  }

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
  fun `decodes zero-payload dropped-frame telemetry without treating it as video`() {
    val droppedFrames = 17L
    val telemetry =
      ByteBuffer.allocate(12)
        .order(ByteOrder.BIG_ENDIAN)
        .putLong((1L shl 59) or droppedFrames)
        .putInt(0)
        .array()

    val out = feed(VideoStreamParser(), streamHeader() + telemetry)

    assertEquals(droppedFrames, out.packets.single().droppedFrames)
    assertTrue(out.packets.single().payload.isEmpty())
  }

  @Test
  fun `decodes a zero-payload heartbeat without treating it as video or dropped-frame telemetry`() {
    // Bit 60, non-config, zero payload — matches videoStreamFraming.ts's encodeHeartbeat().
    val heartbeat =
      ByteBuffer.allocate(12).order(ByteOrder.BIG_ENDIAN).putLong(1L shl 60).putInt(0).array()

    val out = feed(VideoStreamParser(), streamHeader() + heartbeat)

    val packet = out.packets.single()
    assertTrue(packet.heartbeat)
    assertTrue(packet.payload.isEmpty())
    assertEquals(null, packet.droppedFrames)
    assertTrue(!packet.isConfig)
  }

  @Test
  fun `heartbeat is false for an ordinary packet`() {
    val out = feed(VideoStreamParser(), streamHeader() + packet(byteArrayOf(1, 2, 3)))

    assertTrue(!out.packets.single().heartbeat)
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
