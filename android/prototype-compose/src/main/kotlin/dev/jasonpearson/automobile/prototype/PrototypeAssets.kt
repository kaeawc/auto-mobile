package dev.jasonpearson.automobile.prototype

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetChangeListener
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetInfo
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeAssetSource
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import java.io.File
import java.io.IOException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement

/**
 * Immutable image/font bytes by spec asset id. Replace this instance to change assets. Resolvers
 * must be thread safe, quick, and return stable bytes; map entries take precedence over resolvers.
 *
 * @param images Encoded PNG/JPEG/WebP images.
 * @param fonts Encoded font files supported by Android.
 * @param image Fallback image resolver, returning null for unknown ids.
 * @param font Fallback font resolver, returning null for unknown ids.
 */
class PrototypeAssets(
  private val images: Map<String, ByteArray> = emptyMap(),
  private val fonts: Map<String, ByteArray> = emptyMap(),
  private val image: (String) -> ByteArray? = { null },
  private val font: (String) -> ByteArray? = { null },
) {
  internal fun imageBytes(id: String): ByteArray? = images[id] ?: image(id)

  internal fun fontBytes(id: String): ByteArray? = fonts[id] ?: font(id)

  /** Built-in asset choices. */
  companion object {
    /** No custom images or fonts; the renderer uses its missing-asset/default-font fallbacks. */
    val None = PrototypeAssets()
  }
}

internal class EmbeddedPrototypeAssets(private val assets: PrototypeAssets) : PrototypeAssetSource {
  private val fontFiles = mutableMapOf<String, File>()

  // Fonts need paths on Android. Prepare them off main before the first draw; names never contain
  // authored ids. Only paths owned by this composition are deleted on disposal.
  fun prepareFonts(spec: PrototypeSpec, cacheDir: File) {
    fontIds(Json.encodeToJsonElement(spec)).toSet().forEach { id ->
      val bytes = assets.fontBytes(id) ?: return@forEach
      try {
        val file = File.createTempFile("prototype-font-", ".font", cacheDir)
        fontFiles[id] = file
        file.writeBytes(bytes)
      } catch (error: IOException) {
        Log.w("AutoMobilePrototype", "Cannot prepare prototype font; using default", error)
      }
    }
  }

  override fun lookup(id: String): PrototypeAssetInfo? =
    assets.imageBytes(id)?.let { PrototypeAssetInfo(id, "application/octet-stream", it.size) }

  override fun read(id: String): ByteArray? = assets.imageBytes(id)

  override fun file(id: String): File? = fontFiles[id]

  override fun setChangeListener(listener: PrototypeAssetChangeListener?) = Unit

  fun close() {
    fontFiles.values.forEach { it.delete() }
    fontFiles.clear()
  }
}

private fun fontIds(element: JsonElement): List<String> =
  when (element) {
    is JsonObject -> {
      val family = element["fontFamily"] as? JsonObject
      val asset = (family?.get("asset") as? JsonPrimitive)?.content
      listOfNotNull(asset) + element.values.flatMap(::fontIds)
    }
    is JsonArray -> element.flatMap(::fontIds)
    else -> emptyList()
  }
