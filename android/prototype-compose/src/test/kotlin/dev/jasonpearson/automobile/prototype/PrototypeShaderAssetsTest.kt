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
    assertEquals(
      "application/vnd.automobile.agsl",
      assets.lookup("effect", shader = true)?.mimeType,
    )
    assertArrayEquals(bytes, assets.read("effect", shader = true))
    assertArrayEquals(byteArrayOf(32), assets.read("fallback", shader = true))
    assertNull(EmbeddedPrototypeAssets(PrototypeAssets.None).lookup("missing"))
  }

  @Test
  fun `colliding image and shader ids always resolve by requested type`() {
    val image = byteArrayOf(1, 2, 3)
    val shader = "half4 main(float2 p) { return half4(1); }".toByteArray()
    val assets =
      EmbeddedPrototypeAssets(
        PrototypeAssets(images = mapOf("same" to image))
          .withShaders(mapOf("same" to shader, "shaderOnly" to shader)),
      )
    assertArrayEquals(image, assets.read("same"))
    assertArrayEquals(image, assets.read("same", shader = false))
    assertArrayEquals(shader, assets.read("same", shader = true))
    assertEquals("application/octet-stream", assets.lookup("same")?.mimeType)
    assertEquals("application/vnd.automobile.agsl", assets.lookup("same", shader = true)?.mimeType)
    assertNull(assets.read("shaderOnly"))
    assertNull(assets.lookup("shaderOnly"))
  }
}
