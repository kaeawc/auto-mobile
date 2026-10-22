package dev.jasonpearson.automobile.protoviewer

import android.app.Application
import androidx.core.net.toUri
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeDirectoryStore
import dev.jasonpearson.automobile.protocol.PrototypeBundleDirectoryFileSystem
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import dev.jasonpearson.automobile.prototype.PrototypeStorage
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Per-process shared ownership: all document tasks use the same repository/storage locks. */
class ProtoViewerApplication : Application() {
  var servicesFactory: (ProtoViewerApplication) -> ProtoViewerServices = { app ->
    val storage = LibraryStorage(PrototypeStorage.fileBacked(app))
    val root = File(app.filesDir, "library")
    val ids = IdGenerator { UUID.randomUUID().toString() }
    val repository =
      DirectoryLibraryRepository(
        SavedPrototypeDirectoryStore(File(root, "prototypes"), limits = libraryLimits),
        DirectoryLibraryFiles(File(root, "metadata")),
        storage,
        ids,
      )
    val staging =
      File(app.cacheDir, "import").apply {
        check(isDirectory || mkdirs()) { "Cannot create import staging" }
        // A crash mid-commit leaves staging directories behind; nothing else cleans them.
        listFiles()?.forEach { it.deleteRecursively() }
      }
    val sharer =
      CanonicalLibrarySharer(repository, DirectoryLibraryExports(File(app.cacheDir, "export")), ids)
    ProtoViewerServices(
      repository,
      storage,
      importer =
        ValidatedLibraryImporter(
          setOf(app.packageName, "${app.packageName}.exports"),
          ImportContent { uri ->
            app.contentResolver.openInputStream(uri.toUri())
              ?: throw IOException("Content unavailable")
          },
          AutoMobilePrototype.capabilities,
          AndroidImportAssetCheck(),
          DirectoryLibraryImport(
            repository,
            staging.canonicalFile.toPath(),
            PrototypeBundleDirectoryFileSystem(),
            ids,
          ),
        ),
      sharer = sharer,
    )
  }
  val services: ProtoViewerServices by lazy {
    servicesFactory(this).also { services ->
      services.flushScope.launch(services.io) { services.clearStaleExports() }
    }
  }
}

class ProtoViewerServices(
  val repository: LibraryRepository,
  val storage: LibraryStorage,
  val io: CoroutineDispatcher = Dispatchers.IO,
  val clock: LibraryClock = LibraryClock(System::currentTimeMillis),
  val importer: LibraryImporter? = null,
  val sharer: LibrarySharer? = null,
) {
  // Outlives activities so a stop/destroy still finishes the renderer's pending disk flush.
  val flushScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var exportsCleared = false

  @Synchronized
  fun clearStaleExports() {
    if (!exportsCleared) {
      exportsCleared = sharer?.clearStale() !is LibraryResult.Failure
    }
  }

  private val viewers = mutableMapOf<String, suspend (Boolean) -> Unit>()

  fun register(id: String, restart: suspend (Boolean) -> Unit) {
    viewers[id] = restart
  }

  fun unregister(id: String, restart: suspend (Boolean) -> Unit) {
    if (viewers[id] === restart) viewers.remove(id)
  }

  suspend fun restart(id: String, reset: Boolean): Boolean {
    val viewer = viewers[id] ?: return false
    viewer(reset)
    return true
  }
}
