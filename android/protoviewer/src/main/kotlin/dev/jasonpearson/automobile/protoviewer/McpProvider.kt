package dev.jasonpearson.automobile.protoviewer

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileNotFoundException

/**
 * Gives the DUMP-authorized shell access to MCP inbox writes and result reads for secondary users.
 * Files live in the same app-owned external MCP directory as McpInbox. It uses only the provider
 * context because providers start before Application.onCreate.
 */
class McpProvider : ContentProvider() {
  override fun onCreate() = true

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    val file = resolveFile(uri)
    return when {
      uri.pathSegments[0] == "inbox" && mode in setOf("w", "wt") -> {
        val root = file.parentFile!!.parentFile!!
        for (folder in listOf(File(root, "inbox"), File(root, "results"))) {
          if (!folder.mkdirs() && !folder.isDirectory) {
            throw FileNotFoundException("Cannot create MCP folders")
          }
        }
        ParcelFileDescriptor.open(
          file,
          ParcelFileDescriptor.MODE_WRITE_ONLY or
            ParcelFileDescriptor.MODE_CREATE or
            ParcelFileDescriptor.MODE_TRUNCATE,
        )
      }
      uri.pathSegments[0] == "results" && mode == "r" -> {
        if (file.exists()) ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        else
          ParcelFileDescriptor.createPipe().let { pipe ->
            pipe[1].close()
            pipe[0]
          }
      }
      else -> throw IllegalArgumentException("Unsupported MCP file mode")
    }
  }

  private fun resolveFile(uri: Uri): File {
    val segments = uri.pathSegments
    require(
      uri.scheme == "content" &&
        uri.authority == "${requireNotNull(context).packageName}.mcp" &&
        uri.query == null &&
        uri.fragment == null &&
        segments.size == 2,
    ) {
      "Invalid MCP URI"
    }
    require(uri.encodedPath == "/${segments[0]}/${segments[1]}") { "Invalid MCP path" }
    val suffix =
      when (segments[0]) {
        "inbox" -> ".automobile-proto"
        "results" -> ".json"
        else -> throw IllegalArgumentException("Invalid MCP folder")
      }
    require(segments[1].endsWith(suffix) && REQUEST_ID.matches(segments[1].removeSuffix(suffix))) {
      "Invalid MCP request id"
    }
    val external =
      requireNotNull(context).getExternalFilesDir(null)
        ?: throw FileNotFoundException("External MCP storage unavailable")
    return File(external, "mcp/${segments[0]}/${segments[1]}")
  }

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
    if (resolveFile(uri).delete()) 1 else 0

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0

  override fun getType(uri: Uri): String? = null
}
