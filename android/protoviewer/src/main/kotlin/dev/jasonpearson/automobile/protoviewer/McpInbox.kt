package dev.jasonpearson.automobile.protoviewer

import java.io.File
import java.io.IOException
import java.util.logging.Level
import java.util.logging.Logger
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * The MCP host's channel into the library (#13621). The host pushes a canonical bundle into this
 * app's external files directory under mcp/inbox/, then starts McpActivity, which only the adb
 * shell can start (android.permission.DUMP). Keep these names, paths and the result shape in step
 * with src/features/prototype/protoViewer/protoViewerContract.ts.
 *
 * This app creates mcp/, mcp/inbox/ and mcp/results/ itself ([McpInbox.ensureDirectories], reached
 * from the PREPARE action): on API 30+ scoped storage a directory the adb shell creates under this
 * app's Android/data is shell-owned and this app can neither traverse nor create entries in it
 * (#15174), while the shell can still write a file into a directory this app created.
 */
const val MCP_IMPORT_ACTION = "dev.jasonpearson.automobile.protoviewer.mcp.IMPORT"
const val MCP_OPEN_ACTION = "dev.jasonpearson.automobile.protoviewer.mcp.OPEN"
const val MCP_PREPARE_ACTION = "dev.jasonpearson.automobile.protoviewer.mcp.PREPARE"
const val MCP_EXTRA_REQUEST = "request"
const val MCP_EXTRA_LABEL = "label"
const val MCP_EXTRA_LIBRARY_ID = "libraryId"
private const val MAX_LABEL_LENGTH = 120

/**
 * A pushed bundle or a result file this old belongs to a request whose host has long given up (the
 * host waits seconds, not minutes), e.g. a result written after the host's timeout removed its own
 * copy. Generous so a slow import is never swept under its own request.
 */
const val MCP_ORPHAN_MAX_AGE_MS = 10 * 60 * 1000L
private val REQUEST_ID = Regex("[A-Za-z0-9_-]{1,64}")
private val logger: Logger = Logger.getLogger("ProtoViewerMcp")

sealed interface McpCommand {
  val request: String

  data class Import(override val request: String, val label: String?) : McpCommand

  data class Open(override val request: String, val libraryId: String) : McpCommand

  /** Creates the shared-storage folders the host pushes into and reads results from. */
  data class Prepare(override val request: String) : McpCommand

  /** A usable request id with an action this build cannot run: answered, never left waiting. */
  data class Unsupported(override val request: String, val reason: String) : McpCommand

  companion object {
    /** Null only without a usable request id, since there is then no result file to write. */
    fun parse(action: String?, request: String?, label: String?, libraryId: String?): McpCommand? {
      if (request == null || !REQUEST_ID.matches(request)) return null
      return when (action) {
        MCP_IMPORT_ACTION -> Import(request, label)
        MCP_PREPARE_ACTION -> Prepare(request)
        MCP_OPEN_ACTION ->
          libraryId?.let { Open(request, it) } ?: Unsupported(request, "open needs a library id")
        else -> Unsupported(request, "Unknown MCP action; update ProtoViewer")
      }
    }
  }
}

/**
 * Runs one MCP command and writes exactly one result file for it. The host never chooses an entry's
 * source: every import from here is [LibrarySource.mcp] and goes through the same validation as a
 * user import, so it gets the imported-prototype network policy.
 */
class McpInbox(
  private val root: File,
  private val importer: LibraryBytesImporter,
  private val repository: LibraryRepository,
  private val nowMillis: () -> Long = System::currentTimeMillis,
) {
  /**
   * Runs the command and writes its result, except for an entry to open: that is returned so the
   * caller launches the viewer first and then reports it with [reportOpened] or [reportOpenFailed].
   */
  fun handle(command: McpCommand): LibraryEntry? {
    sweepOrphans()
    return dispatch(command)
  }

  private fun dispatch(command: McpCommand): LibraryEntry? =
    when (command) {
      is McpCommand.Import -> {
        write(command.request, importResult(command))
        null
      }
      is McpCommand.Prepare -> {
        write(
          command.request,
          if (ensureDirectories()) prepared(command.request)
          else rejected(command.request, "storage", "Cannot create the MCP folders"),
        )
        null
      }
      is McpCommand.Unsupported -> {
        write(command.request, rejected(command.request, "action", command.reason))
        null
      }
      is McpCommand.Open -> open(command)
    }

  /**
   * Creates `mcp/inbox` and `mcp/results` as this app. False when a folder is missing afterwards,
   * e.g. a shell-created `mcp`.
   */
  fun ensureDirectories(): Boolean =
    // Every folder is attempted, so a blocked inbox does not stop the results folder existing.
    listOf(root, File(root, "inbox"), File(root, "results")).map(::ensureDirectory).all { it }

  /**
   * Deletes regular files in `mcp/inbox` and `mcp/results` not modified for
   * [MCP_ORPHAN_MAX_AGE_MS]: leftovers of a host timeout or a stray push. Best effort and never
   * throws; returns the number of files removed. Folders and fresh files, which may belong to a
   * request in flight, are kept.
   */
  fun sweepOrphans(): Int {
    val cutoff = nowMillis() - MCP_ORPHAN_MAX_AGE_MS
    return listOf("inbox", "results").sumOf { folder ->
      File(root, folder).listFiles().orEmpty().count { file ->
        file.isFile && file.lastModified() < cutoff && file.delete()
      }
    }
  }

  fun reportOpened(command: McpCommand.Open, entry: LibraryEntry) {
    write(command.request, entry("opened", command.request, entry))
  }

  fun reportOpenFailed(command: McpCommand.Open) {
    write(command.request, rejected(command.request, "viewer", "Unable to open the prototype"))
  }

  private fun importResult(command: McpCommand.Import): JsonObject {
    val file = File(root, "inbox/${command.request}.automobile-proto")
    try {
      val label = command.label?.trim()
      if (label != null && !validLabel(label)) {
        return rejected(command.request, "label", "Use a label of 1 to 120 characters on one line")
      }
      if (!file.isFile) {
        return rejected(command.request, "inbox", "No pushed prototype for this request")
      }
      val bytes =
        file.inputStream().use(::readImportLimited)
          ?: return rejected(command.request, "content", "Content exceeds byte limit")
      return when (val imported = importer.importBytes(bytes, LibrarySource.mcp, label)) {
        is LibraryImportResult.Imported -> entry("imported", command.request, imported.entry)
        is LibraryImportResult.Rejected ->
          rejected(
            command.request,
            // The host reports this as an outdated ProtoViewer, not as a broken spec.
            if (imported.reason == UNSUPPORTED_PROTOTYPE_REASON) "capability" else imported.path,
            imported.reason,
          )
      }
    } catch (error: IOException) {
      logger.log(Level.WARNING, "MCP import failed", error)
      return rejected(command.request, "inbox", "Unable to read the pushed prototype")
    } finally {
      if (file.exists() && !file.delete()) logger.warning("Cannot delete ${file.name}")
    }
  }

  private fun open(command: McpCommand.Open): LibraryEntry? {
    // Check the id's shape before reading the library; only metadata is read here.
    if (!validLibraryId(command.libraryId)) {
      write(command.request, notFound(command.request))
      return null
    }
    return when (val listed = repository.list()) {
      is LibraryResult.Failure -> {
        write(command.request, rejected(command.request, "library", listed.error.name))
        null
      }
      is LibraryResult.Success ->
        listed.value.firstOrNull { it.libraryId == command.libraryId }
          ?: run {
            write(command.request, notFound(command.request))
            null
          }
    }
  }

  /** Written under a temporary name and renamed, so the host never reads a partial result. */
  private fun write(request: String, result: JsonObject) {
    val results = File(root, "results")
    if (!ensureDirectory(results)) throw IOException("Cannot create MCP results")
    val temporary = File(results, ".$request.json.tmp")
    temporary.writeText(result.toString())
    if (!temporary.renameTo(File(results, "$request.json"))) {
      temporary.delete()
      throw IOException("Cannot publish the MCP result")
    }
  }
}

// mkdirs() is false when a concurrent request created the directory first; that is fine.
private fun ensureDirectory(directory: File) = directory.mkdirs() || directory.isDirectory

/** One line of 1 to 120 characters: no controls, bidi or other format characters, or separators. */
private fun validLabel(label: String) =
  label.length in 1..MAX_LABEL_LENGTH &&
    label.none {
      it.isISOControl() ||
        it.category in
          setOf(CharCategory.FORMAT, CharCategory.LINE_SEPARATOR, CharCategory.PARAGRAPH_SEPARATOR)
    }

private fun prepared(request: String) = buildJsonObject {
  put("status", "prepared")
  put("request", request)
}

private fun notFound(request: String) = buildJsonObject {
  put("status", "not_found")
  put("request", request)
}

private fun entry(status: String, request: String, entry: LibraryEntry) = buildJsonObject {
  put("status", status)
  put("request", request)
  put("libraryId", entry.libraryId)
  put("label", entry.label)
}

private fun rejected(request: String, path: String, reason: String) = buildJsonObject {
  put("status", "rejected")
  put("request", request)
  put("path", path)
  put("reason", reason)
}
