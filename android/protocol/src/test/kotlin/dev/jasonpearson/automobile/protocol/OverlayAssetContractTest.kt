package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test

class OverlayAssetContractTest {
  @Test
  fun `limits are the conservative caps the TypeScript host also imports`() {
    assertEquals(4 * 1024 * 1024, OverlayAssetContract.MAX_OVERLAY_ASSET_BYTES)
    assertEquals(32, OverlayAssetContract.MAX_OVERLAY_ASSET_COUNT)
    assertEquals(16 * 1024 * 1024, OverlayAssetContract.MAX_OVERLAY_ASSET_TOTAL_BYTES)
    assertEquals(256, OverlayAssetContract.MAX_OVERLAY_ASSET_ID_LENGTH)
    assertEquals(2 * 1024 * 1024, OverlayAssetContract.MAX_OVERLAY_FONT_ASSET_BYTES)
    assertEquals(
      setOf("image/png", "image/jpeg", "image/webp", "font/ttf", "font/otf"),
      OverlayAssetContract.MIME_TYPES,
    )
  }

  @Test
  fun `caps are mutually consistent and far below the frame limit`() {
    assertTrue(
      OverlayAssetContract.MAX_OVERLAY_ASSET_BYTES <=
        OverlayAssetContract.MAX_OVERLAY_ASSET_TOTAL_BYTES
    )
    // Base64 text of the largest asset must sit well inside the 64 MiB inbound frame cap.
    val largestFrame = OverlayAssetContract.MAX_OVERLAY_ASSET_BYTES * 4L / 3 + 1024
    assertTrue(largestFrame < 64L * 1024 * 1024 / 8)
  }
}
