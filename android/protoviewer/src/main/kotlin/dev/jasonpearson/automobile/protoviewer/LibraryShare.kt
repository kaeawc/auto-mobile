package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeAssetSource
import dev.jasonpearson.automobile.protocol.PrototypeBundleAsset
import dev.jasonpearson.automobile.protocol.PrototypeBundleExport
import dev.jasonpearson.automobile.protocol.PrototypeBundleExportInput
import dev.jasonpearson.automobile.protocol.PrototypeBundleExportResult
import dev.jasonpearson.automobile.protocol.PrototypeBundleSecretWarning
import dev.jasonpearson.automobile.protocol.PrototypeBundleSecrets
import java.io.File
import java.io.IOException

interface LibraryExportFiles {
  fun write(name: String, bytes: ByteArray)

  fun delete(name: String)

  fun clear()
}

class DirectoryLibraryExports(private val directory: File) : LibraryExportFiles {
  override fun write(name: String, bytes: ByteArray) {
    if (!directory.isDirectory && !directory.mkdirs())
      throw IOException("Cannot create export cache")
    file(name).outputStream().use { it.write(bytes) }
  }

  override fun delete(name: String) {
    val file = file(name)
    if (file.exists() && !file.delete()) throw IOException("Cannot delete export")
  }

  override fun clear() {
    if (directory.exists() && !directory.deleteRecursively())
      throw IOException("Cannot clear export cache")
  }

  private fun file(name: String): File {
    require(
      name.endsWith(".automobile-proto") && validLibraryId(name.removeSuffix(".automobile-proto")),
    )
    return File(directory, name)
  }
}

data class LibraryShareExport(val name: String, val warnings: List<PrototypeBundleSecretWarning>)

interface LibrarySharer {
  fun prepare(libraryId: String): LibraryResult<LibraryShareExport>

  fun cleanup(name: String): LibraryResult<Unit>

  fun clearStale(): LibraryResult<Unit>
}

class CanonicalLibrarySharer(
  private val repository: LibraryRepository,
  private val files: LibraryExportFiles,
  private val ids: IdGenerator,
) : LibrarySharer {
  override fun prepare(libraryId: String): LibraryResult<LibraryShareExport> {
    val prototype =
      when (val result = repository.get(libraryId)) {
        is LibraryResult.Failure -> return result
        is LibraryResult.Success -> result.value
      }
    val source = SavedPrototypeAssetSource(prototype.saved)
    fun asset(id: String): PrototypeBundleAsset? =
      source.lookup(id)?.let { info ->
        source.read(id)?.let { PrototypeBundleAsset(info.mimeType, it) }
      }
    val spec = prototype.saved.specJson.toByteArray(Charsets.UTF_8)
    val exported = PrototypeBundleExport.export(PrototypeBundleExportInput(spec, ::asset, ::asset))
    if (exported !is PrototypeBundleExportResult.Success)
      return LibraryResult.Failure(LibraryError.Corrupt)
    return storageResult {
      val name = "${ids.newId()}.automobile-proto"
      var written = false
      try {
        files.write(name, exported.bytes)
        written = true
        LibraryShareExport(name, PrototypeBundleSecrets.scan(spec))
      } finally {
        if (!written) files.delete(name)
      }
    }
  }

  override fun cleanup(name: String): LibraryResult<Unit> = storageResult { files.delete(name) }

  override fun clearStale(): LibraryResult<Unit> = storageResult { files.clear() }
}
