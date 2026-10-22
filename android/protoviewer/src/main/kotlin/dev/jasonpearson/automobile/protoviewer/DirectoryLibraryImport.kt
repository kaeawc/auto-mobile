package dev.jasonpearson.automobile.protoviewer

import android.graphics.BitmapFactory
import dev.jasonpearson.automobile.ctrlproxy.prototype.BitmapPrototypeImageDecoder
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeAsset
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeSaveRequest
import dev.jasonpearson.automobile.protocol.PrototypeBundle
import dev.jasonpearson.automobile.protocol.PrototypeBundleCommit
import dev.jasonpearson.automobile.protocol.PrototypeBundleCommitFileSystem
import dev.jasonpearson.automobile.protocol.PrototypeBundleCommitResult
import java.nio.file.Path

/** Bounds-only decoding, on the import I/O dispatcher; never allocate the full image. */
class AndroidImportAssetCheck : ImportAssetCheck {
  override fun invalidPath(bundle: PrototypeBundle): String? =
    bundle.assets.entries
      .firstOrNull { (_, asset) ->
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(asset.bytes, 0, asset.bytes.size, bounds)
        bounds.outWidth <= 0 ||
          bounds.outHeight <= 0 ||
          bounds.outWidth.toLong() * bounds.outHeight >
            BitmapPrototypeImageDecoder.DEFAULT_MAX_DECODED_PIXELS
      }
      ?.key
}

/** Stage the transport atomically before translating into the unchanged saved-store format. */
class DirectoryLibraryImport(
  private val repository: DirectoryLibraryRepository,
  private val stagingRoot: Path,
  private val files: PrototypeBundleCommitFileSystem,
  private val ids: IdGenerator,
) : LibraryImportCommit {
  @Suppress(
    "TooGenericExceptionCaught",
  ) // Injected content/storage adapters may throw operational exceptions.
  @Synchronized
  override fun commit(bundle: PrototypeBundle, source: LibrarySource): LibraryResult<LibraryEntry> {
    val id = ids.newId()
    require(validLibraryId(id))
    val destination = stagingRoot.resolve(id)
    val staged = PrototypeBundleCommit.commit(bundle, destination, files)
    if (staged is PrototypeBundleCommitResult.Failure)
      return LibraryResult.Failure(LibraryError.Storage)
    return try {
      val assets =
        (bundle.assets + bundle.fonts).map { (assetId, asset) ->
          SavedPrototypeAsset(assetId, asset.mediaType, asset.bytes)
        }
      repository.add(
        SavedPrototypeSaveRequest(
          "ignored",
          "Imported prototype",
          bundle.spec.toString(Charsets.UTF_8),
          assets,
        ),
        source,
        bundle.requires,
      )
    } finally {
      // Cleanup after a committed library entry cannot turn success into a reported failure.
      try {
        files.remove(destination)
      } catch (error: Exception) {
        java.util.logging.Logger.getLogger("ProtoViewerImport")
          .log(java.util.logging.Level.WARNING, "Cannot clean import staging", error)
      }
    }
  }
}
