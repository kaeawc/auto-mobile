package dev.jasonpearson.automobile.ctrlproxy.overlay

import java.io.File
import java.io.IOException

/**
 * [OverlayAssetFiles] backed by one directory (the CtrlProxy cache). Names are store-generated
 * tokens; anything else is refused so no caller-influenced string can reach the file system. Writes
 * go to a temporary name first so a failed write never leaves a half-written asset.
 */
class OverlayAssetDirectory(private val directory: File) : OverlayAssetFiles {
  override fun write(name: String, bytes: ByteArray) {
    val target = fileFor(name)
    ensureDirectory()
    val partial = File(directory, "$name$PARTIAL_SUFFIX")
    try {
      partial.writeBytes(bytes)
      if (!partial.renameTo(target)) throw IOException("Could not move asset into place")
    } catch (error: IOException) {
      partial.delete()
      throw error
    }
  }

  override fun read(name: String): ByteArray? {
    val file = fileFor(name)
    return if (file.isFile) file.readBytes() else null
  }

  override fun delete(name: String) {
    fileFor(name).delete()
  }

  override fun file(name: String): File = fileFor(name)

  override fun deleteAll() {
    directory.listFiles()?.forEach { it.delete() }
  }

  private fun ensureDirectory() {
    if (!directory.isDirectory && !directory.mkdirs() && !directory.isDirectory) {
      throw IOException("Could not create overlay asset directory")
    }
  }

  private fun fileFor(name: String): File {
    require(NAME_PATTERN.matches(name)) { "Invalid overlay asset file name" }
    return File(directory, name)
  }

  private companion object {
    const val PARTIAL_SUFFIX = ".partial"
    val NAME_PATTERN = Regex("^asset-[0-9]+$")
  }
}
