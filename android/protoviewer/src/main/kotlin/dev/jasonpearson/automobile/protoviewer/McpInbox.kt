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
 */
const val MCP_IMPORT_ACTION = "dev.jasonpearson.automobile.protoviewer.mcp.IMPORT"
const val MCP_OPEN_ACTION = "dev.jasonpearson.automobile.protoviewer.mcp.OPEN"
const val MCP_EXTRA_REQUEST = "request"
const val MCP_EXTRA_LABEL = "label"
const val MCP_EXTRA_LIBRARY_ID = "libraryId"
private const val MAX_LABEL_LENGTH = 120
private val REQUEST_ID = Regex("[A-Za-z0-9_-]{1,64}")
private val logger: Logger = Logger.getLogger("ProtoViewerMcp")

sealed interface McpCommand {
  val request: String

  data class Import(override val request: String, val label: String?) : McpCommand

  data class Open(override val request: String, val libraryId: String) : McpCommand

  companion object {
    /** Null when the launch is not a well-formed MCP command; nothing is written for it. */
    fun parse(action: String?, request: String?, label: String?, libraryId: String?): McpCommand? {
      if (request == null || !REQUEST_ID.matches(request)) return null
      return when (action) {
        MCP_IMPORT_ACTION -> Import(request, label)
        MCP_OPEN_ACTION -> libraryId?.let { Open(request, it) }
        else -> null
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
) {
  /** The library id to open in a viewer, or null. */
  fun handle(command: McpCommand): String? =
    when (command) {
      is McpCommand.Import -> {
        write(command.request, importResult(command))
        null
      }
      is McpCommand.Open -> open(command)
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
        is LibraryImportResult.Rejected -> rejected(command.request, imported.path, imported.reason)
      }
    } catch (error: IOException) {
      logger.log(Level.WARNING, "MCP import failed", error)
      return rejected(command.request, "inbox", "Unable to read the pushed prototype")
    } finally {
      if (file.exists() && !file.delete()) logger.warning("Cannot delete ${file.name}")
    }
  }

  private fun open(command: McpCommand.Open): String? {
    // Check the id's shape before reading the library; only metadata is read here.
    val found =
      if (!validLibraryId(command.libraryId)) null
      else
        (repository.list() as? LibraryResult.Success)?.value?.firstOrNull {
          it.libraryId == command.libraryId
        }
    if (found == null) {
      write(
        command.request,
        buildJsonObject {
          put("status", "not_found")
          put("request", command.request)
        },
      )
      return null
    }
    write(command.request, entry("opened", command.request, found))
    return found.libraryId
  }

  /** Written under a temporary name and renamed, so the host never reads a partial result. */
  private fun write(request: String, result: JsonObject) {
    val results = File(root, "results")
    if (!results.isDirectory && !results.mkdirs()) throw IOException("Cannot create MCP results")
    val temporary = File(results, ".$request.json.tmp")
    temporary.writeText(result.toString())
    if (!temporary.renameTo(File(results, "$request.json"))) {
      temporary.delete()
      throw IOException("Cannot publish the MCP result")
    }
  }
}

private fun validLabel(label: String) =
  label.length in 1..MAX_LABEL_LENGTH && label.none { it.isISOControl() }

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
