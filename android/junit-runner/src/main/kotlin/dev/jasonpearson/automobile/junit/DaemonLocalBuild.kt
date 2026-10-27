package dev.jasonpearson.automobile.junit

import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal object DaemonLocalBuild {
  /**
   * The local checkout root when `automobile.daemon.local.project.path` (or its env) points at a
   * directory whose built daemon entrypoint exists — i.e. when [buildDaemonCommand] will actually
   * start the *local* daemon instead of the published package. Null otherwise.
   */
  internal fun resolveLocalDaemonProjectRoot(): File? {
    val localPath = resolveLocalProjectPath() ?: return null
    val projectRoot = File(localPath)
    if (!File(projectRoot, "dist/src/index.js").exists()) return null
    return projectRoot
  }

  /** Read the `version` field from a checkout's `package.json`, or null if absent/unreadable. */
  internal fun resolveLocalPackageVersion(projectRoot: File): String? {
    return try {
      val packageJson = File(projectRoot, "package.json")
      if (!packageJson.exists()) return null
      Json { ignoreUnknownKeys = true }
        .parseToJsonElement(packageJson.readText())
        .jsonObject["version"]
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

  /**
   * Entry script the local-override daemon runs (`<local>/dist/src/index.js`), or null when no
   * local override is active. This is the file whose content hash forms the build identity.
   */
  internal fun resolveLocalDaemonEntryScript(): String? =
    resolveLocalDaemonProjectRoot()?.let { File(it, "dist/src/index.js").absolutePath }

  /**
   * Build identity (short content hash of the started daemon's entry script) this runner declares
   * for the handshake gate. Only resolvable for a local override — the published-package daemon's
   * entry script lives in an npm cache this runner cannot hash — so a package-path runner stays a
   * version-only client. Mirrors the TS `computeBuildIdentity` (sha256, first 16 hex chars) so the
   * daemon's own build id compares equal.
   */
  internal fun resolveClientBuildId(): String? =
    resolveLocalDaemonEntryScript()?.let { computeBuildId(File(it)) }

  internal fun computeBuildId(entryScript: File): String? {
    return try {
      if (!entryScript.exists()) return null
      val digest = MessageDigest.getInstance("SHA-256").digest(entryScript.readBytes())
      digest.joinToString("") { formatHexByte(it) }.substring(0, 16)
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

  internal fun resolveLocalProjectPath(): String? {
    val sysProp = SystemPropertyCache.get("automobile.daemon.local.project.path", "")
    val envVar = System.getenv("AUTOMOBILE_DAEMON_LOCAL_PROJECT_PATH")?.trim().orEmpty()
    val path = sysProp.ifEmpty { envVar }
    if (path.isEmpty()) return null
    val dir = File(path)
    return if (dir.isDirectory) dir.absolutePath else null
  }
}
