package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeRemoteImages
import java.io.File
import java.io.IOException

/** Encoded image storage; injected so loader tests require neither disk nor an Android runtime. */
@InternalAutoMobilePrototypeApi
interface PrototypeRemoteImageStore : PrototypeAssetSource {
  fun put(url: String, bytes: ByteArray)
}

/** App-private URL-keyed LRU. Only hashes appear in filenames; the URL is never persisted. */
@InternalAutoMobilePrototypeApi
class FilePrototypeRemoteImageStore(
  private val directory: File,
  private val maxBytes: Long = PrototypeRemoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_DISK_BYTES.toLong(),
  private val clock: () -> Long = System::currentTimeMillis,
) : PrototypeRemoteImageStore {
  @Synchronized
  override fun lookup(id: String): PrototypeAssetInfo? {
    val file = entry(id)
    return if (file.isFile && file.length() in 1..MAX_DOWNLOAD_BYTES)
      PrototypeAssetInfo(id, "application/octet-stream", file.length().toInt())
    else null
  }

  @Synchronized
  override fun read(id: String): ByteArray? {
    if (lookup(id) == null) return null
    val file = entry(id)
    val bytes = file.inputStream().use { it.readBytes() }
    if (!file.setLastModified(clock())) throw IOException("Image cache access failed")
    return bytes
  }

  @Synchronized
  override fun put(url: String, bytes: ByteArray) {
    require(bytes.size.toLong() in 1..minOf(MAX_DOWNLOAD_BYTES, maxBytes))
    if (!directory.isDirectory && !directory.mkdirs()) throw IOException("Image cache unavailable")
    val destination = entry(url)
    val temporary = File(directory, "${destination.name}.tmp")
    try {
      temporary.writeBytes(bytes)
      if (!temporary.renameTo(destination)) throw IOException("Image cache write failed")
      if (!destination.setLastModified(clock())) throw IOException("Image cache access failed")
      val files = directory.listFiles()?.filter { it.name.endsWith(".image") }.orEmpty()
      var total = files.sumOf { it.length() }
      for (file in files.sortedBy { it.lastModified() }) {
        if (total <= maxBytes) break
        val length = file.length()
        if (!file.delete()) throw IOException("Image cache eviction failed")
        total -= length
      }
    } finally {
      // Best-effort cleanup must not mask the write failure; this file is never read as an image.
      temporary.delete()
    }
  }

  override fun setChangeListener(listener: PrototypeAssetChangeListener?) = Unit

  private fun entry(url: String): File {
    val name = sha256Hex(url.toByteArray(Charsets.UTF_8))
    return File(directory, "$name.image")
  }

  private companion object {
    val MAX_DOWNLOAD_BYTES =
      PrototypeRemoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_DOWNLOAD_BYTES.toLong()
  }
}
