package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.ui.text.font.FontFamily
import dev.jasonpearson.automobile.protocol.OverlayColumnNode
import dev.jasonpearson.automobile.protocol.OverlayCondition
import dev.jasonpearson.automobile.protocol.OverlayFontFamily
import dev.jasonpearson.automobile.protocol.OverlayImageNode
import dev.jasonpearson.automobile.protocol.OverlayStyle
import dev.jasonpearson.automobile.protocol.OverlayStyleWhen
import dev.jasonpearson.automobile.protocol.OverlayTextNode
import java.io.File
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Minimal valid sfnt headers, generated at test time: font binaries are LFS-routed in this
 * repository and the store only inspects the version tag.
 */
private object FontBytes {
  fun ttf(size: Int = 32) = padded(size, 0x00, 0x01, 0x00, 0x00)

  fun otf(size: Int = 32) = padded(size, 0x4F, 0x54, 0x54, 0x4F)

  fun trueTag(size: Int = 32) = padded(size, 0x74, 0x72, 0x75, 0x65)

  private fun padded(size: Int, vararg header: Int) =
    ByteArray(size).also { bytes -> header.forEachIndexed { i, b -> bytes[i] = b.toByte() } }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class OverlayFontAssetTest {
  @get:Rule val folder = TemporaryFolder()

  private val files = FakeOverlayAssetFiles()
  private val limits = OverlayAssetLimits(maxAssetBytes = 100, maxFontBytes = 64, maxCount = 4)
  private val store = OverlayAssetStore(files, limits)

  @Test
  fun `stores ttf and otf fonts with any sfnt version tag`() {
    assertTrue(store.put("a", "font/ttf", FontBytes.ttf()) is OverlayAssetPutResult.Stored)
    assertTrue(store.put("b", "font/otf", FontBytes.otf()) is OverlayAssetPutResult.Stored)
    assertTrue(store.put("c", "font/ttf", FontBytes.trueTag()) is OverlayAssetPutResult.Stored)
    // An OpenType file may carry TrueType outlines (version 0x00010000).
    assertTrue(store.put("d", "font/otf", FontBytes.ttf()) is OverlayAssetPutResult.Stored)
    assertEquals(OverlayAssetInfo("b", "font/otf", 32), store.lookup("b"))
  }

  @Test
  fun `rejects an image labelled as a font and a font labelled as an image`() {
    val fakeFont =
      store.put("a", "font/ttf", OverlayAssetBytes.png()) as OverlayAssetPutResult.Rejected
    assertEquals(OverlayAssetRejection.CONTENT_MISMATCH, fakeFont.reason)
    assertTrue(fakeFont.message, fakeFont.message.contains("font"))
    val fakeImage = store.put("b", "image/png", FontBytes.ttf()) as OverlayAssetPutResult.Rejected
    assertEquals(OverlayAssetRejection.CONTENT_MISMATCH, fakeImage.reason)
  }

  @Test
  fun `fonts use the tighter font cap while images keep the image cap`() {
    assertTrue(store.put("f", "font/ttf", FontBytes.ttf(64)) is OverlayAssetPutResult.Stored)
    val over = store.put("g", "font/ttf", FontBytes.ttf(65)) as OverlayAssetPutResult.Rejected
    assertEquals(OverlayAssetRejection.TOO_LARGE, over.reason)
    assertTrue(over.message, over.message.contains("limit is 64"))
    assertTrue(
      store.put("i", "image/png", OverlayAssetBytes.png(100)) is OverlayAssetPutResult.Stored,
    )
  }

  @Test
  fun `file is null for unknown ids and for stores that are not file-backed`() {
    assertNull(store.file("missing"))
    store.put("a", "font/ttf", FontBytes.ttf())
    assertNull(store.file("a"))
  }

  @Test
  fun `file resolves the stored font from a file-backed store and follows removal`() {
    val onDisk = folder.newFile("asset-0")
    val backed =
      object : OverlayAssetFiles by files {
        override fun file(name: String): File? = onDisk.takeIf { name == "asset-0" }
      }
    val fileStore = OverlayAssetStore(backed, limits)
    fileStore.put("brand", "font/ttf", FontBytes.ttf())
    assertEquals(onDisk, fileStore.file("brand"))
    fileStore.remove("brand")
    assertNull(fileStore.file("brand"))
  }

  @Test
  fun `a font family spec decodes and round-trips as an asset or a built-in name`() {
    val json = Json { ignoreUnknownKeys = false }
    val asset = json.decodeFromString<OverlayStyle>("""{"fontFamily":{"asset":"brand"}}""")
    assertEquals(OverlayFontFamily.Asset("brand"), asset.fontFamily)
    assertEquals("""{"fontFamily":{"asset":"brand"}}""", json.encodeToString(asset))
    val named = json.decodeFromString<OverlayStyle>("""{"fontFamily":"serif"}""")
    assertEquals(OverlayFontFamily.Named("serif"), named.fontFamily)
    assertEquals("""{"fontFamily":"serif"}""", json.encodeToString(named))
  }

  @Test
  fun `the render style keeps the font asset id and a built-in fallback family`() {
    val style = mapOverlayStyle(OverlayStyle(fontFamily = OverlayFontFamily.Asset("brand")))
    assertEquals("brand", style.fontAsset)
    assertEquals(FontFamily.Default, style.fontFamily)
    assertNull(
      mapOverlayStyle(OverlayStyle(fontFamily = OverlayFontFamily.Named("serif"))).fontAsset,
    )
  }

  @Test
  fun `asset references include font assets from style and styleWhen`() {
    val root =
      OverlayColumnNode(
        children =
          listOf(
            OverlayTextNode(
              text = "a",
              style = OverlayStyle(fontFamily = OverlayFontFamily.Asset("font-a")),
              styleWhen =
                listOf(
                  OverlayStyleWhen(
                    OverlayCondition(key = "k"),
                    OverlayStyle(fontFamily = OverlayFontFamily.Asset("font-b")),
                  ),
                ),
            ),
            OverlayImageNode(asset = "pic"),
            OverlayTextNode(
              text = "b",
              style = OverlayStyle(fontFamily = OverlayFontFamily.Named("serif")),
            ),
          ),
      )
    assertEquals(listOf("font-a", "font-b", "pic"), overlayAssetReferences(root))
  }

  private class FakeFontSource : OverlayAssetSource {
    val present = mutableMapOf<String, File>()

    override fun lookup(id: String) = present[id]?.let { OverlayAssetInfo(id, "font/ttf", 1) }

    override fun read(id: String): ByteArray? = null

    override fun file(id: String): File? = present[id]

    override fun setChangeListener(listener: OverlayAssetChangeListener?) = Unit
  }

  private class CountingLoader(private val result: () -> FontFamily?) : OverlayFontLoader {
    var loads = 0

    override fun load(file: File): FontFamily? {
      loads++
      return result()
    }
  }

  private val source = FakeFontSource().apply { present["brand"] = File("asset-0") }
  private val warnings = mutableListOf<String>()

  private fun cache(loader: OverlayFontLoader) =
    OverlayFontCache(source, loader) { message, _ -> warnings += message }

  @Test
  fun `a font loads once per asset and is served from the cache after that`() {
    val loader = CountingLoader { FontFamily.Monospace }
    val cache = cache(loader)
    assertSame(FontFamily.Monospace, cache.resolve("brand"))
    assertSame(FontFamily.Monospace, cache.resolve("brand"))
    assertEquals(1, loader.loads)
    assertTrue(warnings.isEmpty())
  }

  @Test
  fun `an unknown asset resolves to null without loading or caching`() {
    val loader = CountingLoader { FontFamily.Monospace }
    val cache = cache(loader)
    assertNull(cache.resolve("later"))
    assertEquals(0, loader.loads)
    source.present["later"] = File("asset-1")
    assertSame(FontFamily.Monospace, cache.resolve("later"))
  }

  @Test
  fun `an unloadable font falls back with one warning however often it is resolved`() {
    val loader = CountingLoader { null }
    val cache = cache(loader)
    repeat(3) { assertNull(cache.resolve("brand")) }
    assertEquals(1, loader.loads)
    assertEquals(1, warnings.size)
  }

  @Test
  fun `a loader that throws falls back to the default family with a warning`() {
    val cache = cache(CountingLoader { throw IllegalStateException("corrupt") })
    assertNull(cache.resolve("brand"))
    assertEquals(1, warnings.size)
  }

  @Test
  fun `invalidating an asset reloads it and moves the version`() {
    var family: FontFamily? = FontFamily.Monospace
    val loader = CountingLoader { family }
    val cache = cache(loader)
    assertSame(FontFamily.Monospace, cache.resolve("brand"))
    val before = cache.version.value
    family = FontFamily.Serif
    cache.invalidate(setOf("brand"))
    assertTrue(cache.version.value > before)
    assertSame(FontFamily.Serif, cache.resolve("brand"))
    assertEquals(2, loader.loads)
  }

  @Test
  fun `invalidating everything drops every cached font`() {
    val loader = CountingLoader { FontFamily.Monospace }
    val cache = cache(loader)
    cache.resolve("brand")
    cache.invalidate(null)
    cache.resolve("brand")
    assertEquals(2, loader.loads)
  }

  @Test
  fun `a removed asset resolves to the fallback after invalidation`() {
    val cache = cache(CountingLoader { FontFamily.Monospace })
    assertSame(FontFamily.Monospace, cache.resolve("brand"))
    source.present.remove("brand")
    cache.invalidate(setOf("brand"))
    assertNull(cache.resolve("brand"))
  }
}
