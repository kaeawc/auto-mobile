package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test

class PrototypeAssetContractTest {
  @Test
  fun `limits are the conservative caps the TypeScript host also imports`() {
    assertEquals(4 * 1024 * 1024, PrototypeAssetContract.MAX_PROTOTYPE_ASSET_BYTES)
    assertEquals(32, PrototypeAssetContract.MAX_PROTOTYPE_ASSET_COUNT)
    assertEquals(16 * 1024 * 1024, PrototypeAssetContract.MAX_PROTOTYPE_ASSET_TOTAL_BYTES)
    assertEquals(256, PrototypeAssetContract.MAX_PROTOTYPE_ASSET_ID_LENGTH)
    assertEquals(2 * 1024 * 1024, PrototypeAssetContract.MAX_PROTOTYPE_FONT_ASSET_BYTES)
    assertEquals(
      setOf("image/png", "image/jpeg", "image/webp", "font/ttf", "font/otf"),
      PrototypeAssetContract.MIME_TYPES,
    )
  }

  @Test
  fun `caps are mutually consistent and far below the frame limit`() {
    assertTrue(
      PrototypeAssetContract.MAX_PROTOTYPE_ASSET_BYTES <=
        PrototypeAssetContract.MAX_PROTOTYPE_ASSET_TOTAL_BYTES,
    )
    // Base64 text of the largest asset must sit well inside the 64 MiB inbound frame cap.
    val largestFrame = PrototypeAssetContract.MAX_PROTOTYPE_ASSET_BYTES * 4L / 3 + 1024
    assertTrue(largestFrame < 64L * 1024 * 1024 / 8)
  }
}
