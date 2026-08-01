package dev.jasonpearson.automobile.video

import dev.jasonpearson.automobile.video.wrappers.DisplayControl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit-tests the pure rotation-swap decision logic for issue #4785: recomputing output dimensions
 * for a new orientation with the SAME preset scaling used at startup, and deciding whether that
 * change actually warrants recreating the encoder/capture. Runs without MediaCodec or a real
 * VirtualDisplay — the framework-touching swap orchestration is a thin wrapper over these seams.
 */
class VideoServerRotationSwapTest {

  private fun display(width: Int, height: Int, rotation: Int) =
    DisplayControl.DisplayInfo(
      width = width,
      height = height,
      densityDpi = 420,
      rotation = rotation,
    )

  @Test
  fun presetScalingSwapsWidthAndHeightWhenPortraitRotatesToLandscape() {
    val portrait = display(width = 1080, height = 2400, rotation = 0)
    val landscape = display(width = 2400, height = 1080, rotation = 1)

    val portraitDims = VideoServer.resolveOutputDimensions(portrait, QualityPreset.MEDIUM, null)
    val landscapeDims = VideoServer.resolveOutputDimensions(landscape, QualityPreset.MEDIUM, null)

    // MEDIUM caps the long edge at 720; the short edge scales proportionally and rounds to even.
    assertEquals(324 to 720, portraitDims)
    assertEquals(720 to 324, landscapeDims)
    assertTrue(
      "a portrait->landscape rotation changes the output size and must swap",
      VideoServer.dimensionsChanged(portraitDims, landscapeDims),
    )
  }

  @Test
  fun oneEightyRotationLeavesDimensionsUnchangedSoNoSwap() {
    val portrait0 = display(width = 1080, height = 2400, rotation = 0)
    val portrait180 = display(width = 1080, height = 2400, rotation = 2)

    val dims0 = VideoServer.resolveOutputDimensions(portrait0, QualityPreset.MEDIUM, null)
    val dims180 = VideoServer.resolveOutputDimensions(portrait180, QualityPreset.MEDIUM, null)

    assertFalse(
      "0<->180 keeps the same logical size, so no encoder swap is needed",
      VideoServer.dimensionsChanged(dims0, dims180),
    )
  }

  @Test
  fun explicitSizeOverridePinsDimensionsRegardlessOfOrientation() {
    val portrait = display(width = 1080, height = 2400, rotation = 0)
    val landscape = display(width = 2400, height = 1080, rotation = 1)
    val pinned = 640 to 480

    val portraitDims = VideoServer.resolveOutputDimensions(portrait, QualityPreset.MEDIUM, pinned)
    val landscapeDims = VideoServer.resolveOutputDimensions(landscape, QualityPreset.MEDIUM, pinned)

    // Least-surprising behavior for an explicit --size: the operator asked for a specific frame
    // size, so rotation must not silently swap it; both orientations resolve to the pinned WxH.
    assertEquals(pinned, portraitDims)
    assertEquals(pinned, landscapeDims)
    assertFalse(
      "--size pins WxH across rotation, so no swap occurs",
      VideoServer.dimensionsChanged(portraitDims, landscapeDims),
    )
  }

  @Test
  fun rotatingBackRestoresOriginalDimensions() {
    val portrait = display(width = 1080, height = 2400, rotation = 0)
    val landscape = display(width = 2400, height = 1080, rotation = 1)

    val portraitDims = VideoServer.resolveOutputDimensions(portrait, QualityPreset.MEDIUM, null)
    val landscapeDims = VideoServer.resolveOutputDimensions(landscape, QualityPreset.MEDIUM, null)
    val backToPortraitDims =
      VideoServer.resolveOutputDimensions(portrait, QualityPreset.MEDIUM, null)

    assertTrue(VideoServer.dimensionsChanged(portraitDims, landscapeDims))
    assertEquals("rotating back restores the original dimensions", portraitDims, backToPortraitDims)
    assertTrue(VideoServer.dimensionsChanged(landscapeDims, backToPortraitDims))
  }

  @Test
  fun replayCacheResetClearsDecoderStateSoNoNewSpsIsPairedWithStaleIdr() {
    // The rotation swap resets the writer's replay cache
    // (VideoStreamWriter.resetReplayCacheForResize
    // -> VideoPacketCache.reset) so a client reconnecting mid-swap never replays the new encoder's
    // SPS/PPS against the old encoder's IDR. Verify the reset clears both halves together.
    val cache = VideoPacketCache()
    val config =
      CachedVideoPacket(VideoStreamProtocol.PACKET_FLAG_CONFIG or 10L, byteArrayOf(1, 2, 3))
    val idr =
      CachedVideoPacket(VideoStreamProtocol.PACKET_FLAG_KEY_FRAME or 20L, byteArrayOf(4, 5, 6))
    cache.remember(config)
    cache.remember(idr)
    assertEquals("config + IDR are both cached before reset", 2, cache.replay().size)

    cache.reset()

    assertTrue("reset clears the replay cache entirely", cache.replay().isEmpty())
  }
}
