package dev.jasonpearson.automobile.prototype

import org.junit.Assert.*
import org.junit.Test

class PrototypeShaderAssetsTest {
  @Test
  fun `embedded shader bytes retain AGSL MIME and map overrides resolver`() {
    val bytes = "half4 main(float2 p) { return half4(1); }".toByteArray()
    val assets =
      EmbeddedPrototypeAssets(
        PrototypeAssets()
          .withShaders(shaders = mapOf("effect" to bytes), shader = { byteArrayOf(32) }),
      )
    assertEquals("application/vnd.automobile.agsl", assets.lookup("effect")?.mimeType)
    assertArrayEquals(bytes, assets.read("effect"))
    assertArrayEquals(byteArrayOf(32), assets.read("fallback"))
    assertNull(EmbeddedPrototypeAssets(PrototypeAssets.None).lookup("missing"))
  }
}
