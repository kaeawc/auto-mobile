package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SavedPrototypeAssetSourceTest {
  @Test
  fun `snapshot supplies verified image metadata bytes and font paths`() {
    val fixture = savedPrototypeFixture()
    val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    val font = byteArrayOf(0, 1, 0, 0)
    val fontFile = File("snapshot-font")
    val loaded =
      SavedPrototypeLoadResult.Loaded(
        fixture.id,
        fixture.label,
        fixture.slug,
        fixture.savedAt,
        fixture.spec,
        fixture.specJson,
        mapOf("image" to png, "font" to font),
        mapOf("font" to fontFile),
        setOf("font"),
      )
    val source = SavedPrototypeAssetSource(loaded)
    assertEquals(PrototypeAssetInfo("image", "image/png", png.size), source.lookup("image"))
    assertArrayEquals(png, source.read("image"))
    assertTrue(isFontMimeType(checkNotNull(source.lookup("font")).mimeType))
    assertEquals(fontFile, source.file("font"))
    source.setChangeListener { error("Immutable snapshots must not send changes") }
    assertNull(source.lookup("missing"))
    assertNull(source.read("missing"))
    assertNull(source.file("missing"))
  }
}
