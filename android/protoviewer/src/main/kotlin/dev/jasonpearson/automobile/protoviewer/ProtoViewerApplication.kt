package dev.jasonpearson.automobile.protoviewer

import android.app.Application
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeDirectoryStore
import dev.jasonpearson.automobile.prototype.PrototypeStorage
import java.io.File
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** Per-process shared ownership: all document tasks use the same repository/storage locks. */
class ProtoViewerApplication : Application() {
  var servicesFactory: (ProtoViewerApplication) -> ProtoViewerServices = { app ->
    val storage = LibraryStorage(PrototypeStorage.fileBacked(app))
    val root = File(app.filesDir, "library")
    ProtoViewerServices(
      DirectoryLibraryRepository(
        SavedPrototypeDirectoryStore(File(root, "prototypes"), limits = libraryLimits),
        DirectoryLibraryFiles(File(root, "metadata")),
        storage,
      ),
      storage,
    )
  }
  val services: ProtoViewerServices by lazy { servicesFactory(this) }
}

class ProtoViewerServices(
  val repository: LibraryRepository,
  val storage: LibraryStorage,
  val io: CoroutineDispatcher = Dispatchers.IO,
  val clock: LibraryClock = LibraryClock(System::currentTimeMillis),
) {
  // Outlives activities so a stop/destroy still finishes the renderer's pending disk flush.
  val flushScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
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
