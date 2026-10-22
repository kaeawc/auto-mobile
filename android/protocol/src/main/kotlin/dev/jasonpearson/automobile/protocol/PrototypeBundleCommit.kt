package dev.jasonpearson.automobile.protocol

import java.nio.file.Path

/**
 * Parent is app-owned, destination is a fresh app-generated ID, and callers serialize commits.
 * Adapters must check directories without following links, exclusively create files with NOFOLLOW,
 * create fresh sibling staging directories, and rename atomically on the same volume.
 */
interface PrototypeBundleCommitFileSystem {
  fun assertRealDirectory(path: Path)

  fun assertAbsent(path: Path)

  fun makeStagingDirectory(parent: Path, mode: Int): Path

  fun mkdir(path: Path, mode: Int)

  fun writeExclusiveNoFollow(path: Path, bytes: ByteArray)

  fun rename(from: Path, to: Path)

  fun remove(path: Path)
}

sealed interface PrototypeBundleCommitResult {
  data class Success(val destination: Path) : PrototypeBundleCommitResult

  data class Failure(val message: String, val cleanupFailed: Boolean = false) :
    PrototypeBundleCommitResult {
    val code = "storage_failure"
  }
}

object PrototypeBundleCommit {
  @Suppress(
    "TooGenericExceptionCaught",
  ) // Caller-owned storage adapters may throw any operational exception.
  fun commit(
    bundle: PrototypeBundle,
    destDir: Path,
    fs: PrototypeBundleCommitFileSystem,
  ): PrototypeBundleCommitResult {
    var stage: Path? = null
    return try {
      val destination = destDir.toAbsolutePath().normalize()
      val parent = checkNotNull(destination.parent)
      fs.assertRealDirectory(parent)
      fs.assertAbsent(destination)
      val files =
        PrototypeBundleExport.canonicalFiles(
          PrototypeBundleExportInput(bundle.spec, bundle.assets::get, bundle.fonts::get),
          bundle.requires,
        )
      val fresh = fs.makeStagingDirectory(parent, 448)
      require(
        fresh.isAbsolute &&
          fresh.normalize() == fresh &&
          fresh.parent == parent &&
          fresh != destination,
      ) {
        "Staging directory must be a fresh sibling of destination"
      }
      stage = fresh
      fs.assertRealDirectory(fresh)
      for (directory in listOf("assets", "fonts")) {
        val path = fresh.resolve(directory)
        fs.mkdir(path, 448)
        fs.assertRealDirectory(path)
      }
      for ((path, bytes) in files) fs.writeExclusiveNoFollow(fresh.resolve(path), bytes)
      fs.assertRealDirectory(parent)
      fs.assertRealDirectory(fresh)
      fs.assertAbsent(destination)
      fs.rename(fresh, destination)
      PrototypeBundleCommitResult.Success(destination)
    } catch (error: Exception) {
      var cleanupFailed = false
      stage?.let {
        try {
          fs.remove(it)
        } catch (_: Exception) {
          cleanupFailed = true
        }
      }
      // Keep the exception type: AccessDeniedException's message is only the denied path.
      val message = error.message?.let { "${error.javaClass.simpleName}: $it" }
      PrototypeBundleCommitResult.Failure(message ?: "Bundle commit failed", cleanupFailed)
    }
  }
}
