package dev.jasonpearson.automobile.video

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class VideoStreamProtocolTest {
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
  fun reconnectWindowOnlyExpiresAfterAConnectedClientIsLost() {
    val window = ClientReconnectWindow(windowMs = 5_000)

    assertEquals(false, window.hasExpired(10_000))
    window.onClientConnected()
    window.onClientDisconnected(100)
    assertEquals(false, window.hasExpired(5_099))
    assertEquals(true, window.hasExpired(5_100))

    window.onClientConnected()
    assertEquals(false, window.hasExpired(10_000))
  }
}
