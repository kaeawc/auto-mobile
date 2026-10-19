package dev.jasonpearson.automobile.junit

import java.io.File
import java.io.IOException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal object DaemonPidFiles {
  /** Read the daemon's recorded version from its PID file, or null if absent/unreadable. */
  internal fun readDaemonVersionFromPidFile(path: String): String? =
    readPidFileString(path, "version")

  /** Read the daemon's recorded CtrlProxy asset version from its PID file, or null. */
  internal fun readDaemonAssetVersionFromPidFile(path: String): String? =
    readPidFileString(path, "assetVersion")

  /** Read the daemon's recorded build-identity hash from its PID file, or null. */
  internal fun readDaemonBuildIdFromPidFile(path: String): String? =
    readPidFileString(path, "buildId")

  /** Read the daemon's recorded entry-script path from its PID file, or null. */
  internal fun readDaemonEntryScriptFromPidFile(path: String): String? =
    readPidFileString(path, "entryScript")

  /**
   * Read when the daemon generation started (epoch ms, the PID file's `startedAt`), or null if
   * absent/unreadable.
   */
  internal fun readDaemonStartedAtMsFromPidFile(path: String): Long? =
    readPidFileString(path, "startedAt")?.let { it.toLongOrNull() ?: it.toDoubleOrNull()?.toLong() }

  /** Read the daemon's process id from its PID file, or null if absent/unreadable. */
  internal fun readDaemonPidFromPidFile(path: String): Long? =
    readPidFileString(path, "pid")?.toLongOrNull()?.takeIf { it > 0 }

  internal fun readPidFileString(path: String, field: String): String? {
    return try {
      val file = File(path)
      if (!file.exists()) return null
      Json { ignoreUnknownKeys = true }
        .parseToJsonElement(file.readText())
        .jsonObject[field]
        ?.jsonPrimitive
        ?.contentOrNull
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
    } catch (e: IOException) {
      println("Daemon identity read failed: $e")
      null
    } catch (e: IllegalArgumentException) {
      println("Invalid daemon identity: $e")
      null
    } catch (e: SecurityException) {
      println("Daemon identity inaccessible: $e")
      null
    }
  }
}
