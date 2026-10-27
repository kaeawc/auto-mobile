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
 * Immutable image/font/shader bytes by spec asset id. Replace this instance to change assets.
 * Resolvers must be thread safe, quick, and return stable bytes; map entries take precedence over
 * resolvers.
 *
 * @param images Encoded PNG/JPEG/WebP images.
 * @param fonts Encoded font files supported by Android.
 * @param image Fallback image resolver, returning null for unknown ids.
 * @param font Fallback font resolver, returning null for unknown ids.
 */
class PrototypeAssets
private constructor(
  private val images: Map<String, ByteArray>,
  private val fonts: Map<String, ByteArray>,
  private val image: (String) -> ByteArray?,
  private val font: (String) -> ByteArray?,
  private val shaders: Map<String, ByteArray>,
  private val shader: (String) -> ByteArray?,
) {
  // Preserve the existing constructor and its default-argument ABI for embedding applications.
  @JvmOverloads
  constructor(
    images: Map<String, ByteArray> = emptyMap(),
    fonts: Map<String, ByteArray> = emptyMap(),
    image: (String) -> ByteArray? = { null },
    font: (String) -> ByteArray? = { null },
  ) : this(images, fonts, image, font, emptyMap(), { null })

  /** A new immutable asset set with UTF-8 AGSL sources, compiled on API 33+ before rendering. */
  fun withShaders(
    shaders: Map<String, ByteArray> = emptyMap(),
    shader: (String) -> ByteArray? = { null },
  ): PrototypeAssets = PrototypeAssets(images, fonts, image, font, shaders, shader)

  internal fun imageBytes(id: String): ByteArray? = images[id] ?: image(id)

  internal fun fontBytes(id: String): ByteArray? = fonts[id] ?: font(id)

  internal fun shaderBytes(id: String): ByteArray? = shaders[id] ?: shader(id)

  /** Built-in asset choices. */
  companion object {
    /**
     * No custom images, fonts or shaders; the renderer uses its missing-asset/default-font
     * fallbacks.
     */
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

  override fun lookup(id: String): PrototypeAssetInfo? = lookup(id, shader = false)

  override fun read(id: String): ByteArray? = read(id, shader = false)

  override fun lookup(id: String, shader: Boolean): PrototypeAssetInfo? =
    if (shader)
      assets.shaderBytes(id)?.let {
        PrototypeAssetInfo(id, "application/vnd.automobile.agsl", it.size)
      }
    else assets.imageBytes(id)?.let { PrototypeAssetInfo(id, "application/octet-stream", it.size) }

  override fun read(id: String, shader: Boolean): ByteArray? =
    if (shader) assets.shaderBytes(id) else assets.imageBytes(id)

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
