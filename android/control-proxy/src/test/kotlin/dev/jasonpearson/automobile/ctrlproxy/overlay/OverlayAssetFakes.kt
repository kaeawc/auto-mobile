package dev.jasonpearson.automobile.ctrlproxy.overlay

import java.io.IOException

/** In-memory [OverlayAssetFiles] with failure injection; nothing touches the file system. */
internal class FakeOverlayAssetFiles : OverlayAssetFiles {
  val stored = LinkedHashMap<String, ByteArray>()
  var failWrites = false
  var failReads = false
  var deleteAllCalls = 0

  override fun write(name: String, bytes: ByteArray) {
    if (failWrites) throw IOException("fake write failure")
    stored[name] = bytes
  }

  override fun read(name: String): ByteArray? {
    if (failReads) throw IOException("fake read failure")
    return stored[name]
  }

  override fun delete(name: String) {
    stored.remove(name)
  }

  override fun deleteAll() {
    deleteAllCalls++
    stored.clear()
  }
}

/** Smallest byte strings whose magic numbers satisfy the store's signature check. */
internal object OverlayAssetBytes {
  fun png(size: Int = 16): ByteArray = padded(size, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)

  fun jpeg(size: Int = 16): ByteArray = padded(size, 0xFF, 0xD8, 0xFF, 0xE0)

  fun webp(size: Int = 16): ByteArray =
    padded(size, 0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)

  private fun padded(size: Int, vararg header: Int): ByteArray {
    require(size >= header.size)
    return ByteArray(size).also { bytes -> header.forEachIndexed { i, b -> bytes[i] = b.toByte() } }
  }
}
