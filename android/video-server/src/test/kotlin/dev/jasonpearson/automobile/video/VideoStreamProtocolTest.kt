package dev.jasonpearson.automobile.video

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoStreamProtocolTest {
  @Test
  fun onlyTheRequestKeyFrameByteIsAKnownCommand() {
    assertTrue(VideoStreamProtocol.isKnownCommand(VideoStreamProtocol.COMMAND_REQUEST_KEY_FRAME))
    assertEquals(
      setOf(VideoStreamProtocol.COMMAND_REQUEST_KEY_FRAME),
      VideoStreamProtocol.KNOWN_COMMANDS,
    )
    // Every other byte the reader could pull off input.read() (0x00 and 0x02..0xFF) is unknown.
    assertFalse(VideoStreamProtocol.isKnownCommand(0x00))
    for (byte in 0x02..0xFF) {
      assertFalse(
        "byte $byte must not be a known command",
        VideoStreamProtocol.isKnownCommand(byte),
      )
    }
  }

  @Test
  fun legacyHeaderUsesH264WidthAndHeight() {
    val expected =
      byteArrayOf(
        0x68,
        0x32,
        0x36,
        0x34,
        0x00,
        0x00,
        0x01,
        0xe0.toByte(),
        0x00,
        0x00,
        0x04,
        0x10,
      )

    assertArrayEquals(expected, VideoStreamProtocol.legacyHeader(width = 480, height = 1040))
  }

  @Test
  fun muxHeaderAdvertisesVideoAndAudioTracks() {
    val expected =
      byteArrayOf(
        0x61,
        0x6d,
        0x75,
        0x78,
        0x00,
        0x00,
        0x00,
        0x01,
        0x00,
        0x00,
        0x00,
        0x02,
        0x00,
        0x00,
        0x00,
        0x01,
        0x68,
        0x32,
        0x36,
        0x34,
        0x00,
        0x00,
        0x01,
        0xe0.toByte(),
        0x00,
        0x00,
        0x04,
        0x10,
        0x00,
        0x00,
        0x00,
        0x02,
        0x73,
        0x31,
        0x36,
        0x6c,
        0x00,
        0x00,
        0x1f,
        0x40,
        0x00,
        0x00,
        0x00,
        0x01,
      )

    assertArrayEquals(
      expected,
      VideoStreamProtocol.muxHeader(
        width = 480,
        height = 1040,
        audioSampleRateHz = 8000,
        audioChannels = 1,
      ),
    )
  }

  @Test
  fun videoPacketHeaderPreservesFlagsAndSizeInLegacyAndMuxForms() {
    val ptsAndFlags =
      VideoStreamProtocol.ptsAndFlags(
        presentationTimeUs = 123,
        isConfig = true,
        isKeyFrame = true,
      )

    assertEquals(
      VideoStreamProtocol.PACKET_FLAG_CONFIG or VideoStreamProtocol.PACKET_FLAG_KEY_FRAME or 123,
      ptsAndFlags,
    )
    assertArrayEquals(
      byteArrayOf(
        0xc0.toByte(),
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x7b,
        0x00,
        0x00,
        0x00,
        0x03,
      ),
      VideoStreamProtocol.packetHeader(
        audioEnabled = false,
        trackId = VideoStreamProtocol.TRACK_ID_VIDEO,
        ptsAndFlags = ptsAndFlags,
        size = 3,
      ),
    )
    assertArrayEquals(
      byteArrayOf(
        0x00,
        0x00,
        0x00,
        0x01,
        0xc0.toByte(),
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x7b,
        0x00,
        0x00,
        0x00,
        0x03,
      ),
      VideoStreamProtocol.packetHeader(
        audioEnabled = true,
        trackId = VideoStreamProtocol.TRACK_ID_VIDEO,
        ptsAndFlags = ptsAndFlags,
        size = 3,
      ),
    )
  }

  @Test
  fun framedPacketConcatenatesHeaderThenPayloadInOneBuffer() {
    val ptsAndFlags =
      VideoStreamProtocol.ptsAndFlags(
        presentationTimeUs = 123,
        isConfig = true,
        isKeyFrame = true,
      )
    val payload = byteArrayOf(0x0a, 0x0b, 0x0c)

    val framed =
      VideoStreamProtocol.framedPacket(
        audioEnabled = false,
        trackId = VideoStreamProtocol.TRACK_ID_VIDEO,
        ptsAndFlags = ptsAndFlags,
        data = payload,
      )

    // Header (12 bytes for legacy) + payload assembled into a single write buffer (issue #4743),
    // byte-identical to header ++ payload so on-wire framing is unchanged.
    val header =
      VideoStreamProtocol.packetHeader(
        audioEnabled = false,
        trackId = VideoStreamProtocol.TRACK_ID_VIDEO,
        ptsAndFlags = ptsAndFlags,
        size = payload.size,
      )
    assertEquals(header.size + payload.size, framed.size)
    assertArrayEquals(header, framed.copyOfRange(0, header.size))
    assertArrayEquals(payload, framed.copyOfRange(header.size, framed.size))
  }

  @Test
  fun framedPacketUsesLargerMuxHeaderWhenAudioEnabled() {
    val payload = byteArrayOf(0x01, 0x02)

    val framed =
      VideoStreamProtocol.framedPacket(
        audioEnabled = true,
        trackId = VideoStreamProtocol.TRACK_ID_VIDEO,
        ptsAndFlags = 5L,
        data = payload,
      )

    // Mux packet header is 16 bytes; framed buffer is header ++ payload.
    assertEquals(16 + payload.size, framed.size)
    assertArrayEquals(payload, framed.copyOfRange(16, framed.size))
  }

  @Test
  fun replayedPacketFlagPreservesTheOriginalFlagsAndPts() {
    val original =
      VideoStreamProtocol.ptsAndFlags(
        presentationTimeUs = 123,
        isConfig = false,
        isKeyFrame = true,
      )

    val replayed = VideoStreamProtocol.replayed(original)

    assertEquals(
      VideoStreamProtocol.PACKET_FLAG_REPLAYED or VideoStreamProtocol.PACKET_FLAG_KEY_FRAME or 123,
      replayed,
    )
    assertEquals(123, replayed and VideoStreamProtocol.PTS_MASK)
  }

  @Test
  fun requestKeyFrameCommandByteMatchesHostContract() {
    // The host (PersistentEncoderH264Source.ts) writes this exact byte to request
    // a fresh IDR. Changing it silently would break keyframe-on-demand.
    assertEquals(0x01, VideoStreamProtocol.COMMAND_REQUEST_KEY_FRAME)
  }

  @Test
  fun audioPacketHeaderUsesAudioTrackWithoutFlags() {
    assertArrayEquals(
      byteArrayOf(
        0x00,
        0x00,
        0x00,
        0x02,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x04,
        0xd2.toByte(),
        0x00,
        0x00,
        0x00,
        0x04,
      ),
      VideoStreamProtocol.packetHeader(
        audioEnabled = true,
        trackId = VideoStreamProtocol.TRACK_ID_AUDIO,
        ptsAndFlags = 1234,
        size = 4,
      ),
    )
  }

  @Test
  fun cachedDecoderStateReplaysConfigThenLatestIdr() {
    val cache = VideoPacketCache()
    cache.remember(
      CachedVideoPacket(
        VideoStreamProtocol.PACKET_FLAG_CONFIG or 10,
        byteArrayOf(0, 0, 0, 1, 0x67),
      )
    )
    cache.remember(
      CachedVideoPacket(
        VideoStreamProtocol.PACKET_FLAG_KEY_FRAME or 20,
        byteArrayOf(0, 0, 0, 1, 0x65, 1),
      )
    )
    cache.remember(
      CachedVideoPacket(
        VideoStreamProtocol.PACKET_FLAG_KEY_FRAME or 30,
        byteArrayOf(0, 0, 0, 1, 0x65, 2),
      )
    )

    val replay = cache.replay()

    assertEquals(2, replay.size)
    assertEquals(VideoStreamProtocol.PACKET_FLAG_CONFIG or 10, replay[0].ptsAndFlags)
    assertEquals(VideoStreamProtocol.PACKET_FLAG_KEY_FRAME or 30, replay[1].ptsAndFlags)
    assertArrayEquals(byteArrayOf(0, 0, 0, 1, 0x65, 2), replay[1].data)
  }

  @Test
  fun reconnectWindowExpiresAfterInitialAttachOrClientDisconnect() {
    var elapsedRealtimeMs = 0L
    val window = ReconnectWindow({ elapsedRealtimeMs }, durationMs = 5_000L)

    window.start()
    elapsedRealtimeMs = 4_999L
    assertEquals(false, window.isExpired())
    elapsedRealtimeMs = 5_000L
    assertEquals(true, window.isExpired())

    window.onClientAttached()
    assertEquals(false, window.isExpired())
    elapsedRealtimeMs = 5_200L
    window.onClientDetached()
    elapsedRealtimeMs = 10_199L
    assertEquals(false, window.isExpired())
    elapsedRealtimeMs = 10_200L
    assertEquals(true, window.isExpired())
  }
}
