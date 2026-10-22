package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeAssetContract
import java.io.File

/** Immutable verified snapshot; infer decoder metadata using the existing signature checks. */
class SavedPrototypeAssetSource(private val loaded: SavedPrototypeLoadResult.Loaded) :
  PrototypeAssetSource {
  private val metadata = mutableMapOf<String, PrototypeAssetInfo?>()

  @Synchronized
  override fun lookup(id: String): PrototypeAssetInfo? =
    metadata.getOrPut(id) {
      loaded.assetBytes(id)?.let { bytes ->
        PrototypeAssetContract.MIME_TYPES.firstOrNull { matchesSignature(it, bytes) }
          ?.let {
            PrototypeAssetInfo(id, it, bytes.size)
          }
      }
    }

  override fun read(id: String): ByteArray? = loaded.assetBytes(id)

  override fun file(id: String): File? = loaded.fontFile(id) ?: loaded.assetFile(id)

  override fun setChangeListener(listener: PrototypeAssetChangeListener?) = Unit
}
