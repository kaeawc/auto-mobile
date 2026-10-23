package dev.jasonpearson.automobile.protoviewer

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.core.net.toUri
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeEgressPolicy
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHttpClient
import dev.jasonpearson.automobile.ctrlproxy.prototype.RetrofitPrototypeHttpClient
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
import okhttp3.OkHttpClient

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
    val importer =
      ValidatedLibraryImporter(
        setOf(app.packageName, "${app.packageName}.exports"),
        ImportContent { uri ->
          app.contentResolver.openInputStream(uri.toUri())
            ?: throw IOException("Content unavailable")
        },
        AutoMobilePrototype.capabilities,
        AndroidImportAssetCheck(),
        staging.canonicalFile.toPath().let { stagingRoot ->
          DirectoryLibraryImport(
            repository,
            stagingRoot,
            PrototypeBundleDirectoryFileSystem(stagingRoot),
            ids,
          )
        },
      )
    ProtoViewerServices(
      repository,
      storage,
      importer = importer,
      mcpInbox =
        app.getExternalFilesDir(null)?.let { McpInbox(File(it, "mcp"), importer, repository) },
      sharer = sharer,
      settings = SharedPreferencesSettingsStore(app.getSharedPreferences("settings", MODE_PRIVATE)),
    )
  }
  val services: ProtoViewerServices by lazy {
    servicesFactory(this).also { services ->
      services.flushScope.launch(services.io) { services.clearStaleExports() }
    }
  }
}

// Application composition root: keep independent dependencies explicit for constructor injection.
@Suppress("LongParameterList")
class ProtoViewerServices(
  val repository: LibraryRepository,
  val storage: LibraryStorage,
  val io: CoroutineDispatcher = Dispatchers.IO,
  val clock: LibraryClock = LibraryClock(System::currentTimeMillis),
  val importer: LibraryImporter? = null,
  /** Null when shared storage is unavailable; the MCP host then times out and says so. */
  val mcpInbox: McpInbox? = null,
  val sharer: LibrarySharer? = null,
  val settings: SettingsStore,
  allowedClient: () -> PrototypeHttpClient = {
    RetrofitPrototypeHttpClient(OkHttpClient(), policy = PrototypeEgressPolicy())
  },
  val renderWatchdog: RenderWatchdog = DeadlineRenderWatchdog(),
  val renderer: ViewerRenderer = GuardedViewerRenderer,
  val localNetworkPermission: (ComponentActivity, (Boolean) -> Unit) -> LocalNetworkPermission =
    ::AndroidLocalNetworkPermission,
  val localNetworkGrant: LocalNetworkGrant = AndroidLocalNetworkGrant,
) {
  val networkClient = SettingsPrototypeHttpClient(settings, allowedClient)

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
