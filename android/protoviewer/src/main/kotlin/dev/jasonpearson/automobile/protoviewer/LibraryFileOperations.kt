package dev.jasonpearson.automobile.protoviewer

import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * Metadata is a sibling tree to the saved store: library/{prototypes,metadata/<uuid>/library.json}.
 */
interface LibraryFileOperations {
  fun ids(): List<String>

  fun read(id: String): String

  fun write(id: String, text: String)
}

class DirectoryLibraryFiles(private val root: File) : LibraryFileOperations {
  override fun ids(): List<String> {
    if (!root.exists()) return emptyList()
    return (root.listFiles() ?: throw IOException("Cannot list library"))
      .filter { it.isDirectory && validLibraryId(it.name) }
      .map { it.name }
  }

  override fun read(id: String): String {
    val file = fileFor(id)
    if (file.length() > MAX_METADATA_BYTES) throw IOException("Metadata exceeds limit")
    return file.readText(Charsets.UTF_8)
  }

  override fun write(id: String, text: String) {
    val target = fileFor(id)
    val directory = checkNotNull(target.parentFile)
    if (!directory.isDirectory && !directory.mkdirs())
      throw IOException("Cannot create library metadata")
    val temp = File(directory, "library.json.tmp")
    try {
      FileOutputStream(temp).use { stream ->
        stream.write(text.toByteArray(Charsets.UTF_8))
        stream.fd.sync()
      }
      if (!temp.renameTo(target)) throw IOException("Cannot commit library metadata")
    } finally {
      if (temp.exists()) temp.delete()
    }
  }

  private fun fileFor(id: String): File {
    require(validLibraryId(id))
    return File(File(root, id), "library.json")
  }

  private companion object {
    const val MAX_METADATA_BYTES = 65_536
  }
}
