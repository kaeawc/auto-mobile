package dev.jasonpearson.automobile.protocol

import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardOpenOption.CREATE_NEW
import java.nio.file.StandardOpenOption.WRITE
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermissions

/**
 * POSIX app-owned storage adapter rooted at [root]. Unsupported permissions/atomic rename fail
 * closed.
 *
 * Only [root] and the components below it are verified: ancestors above the app-owned root belong
 * to the platform (Android's `/data`, `/data/user/0`) and apps cannot list them, so walking them
 * failed every import with a storage error. Paths outside [root] are rejected outright.
 */
class PrototypeBundleDirectoryFileSystem(root: Path) : PrototypeBundleCommitFileSystem {
  private val root: Path = root.toAbsolutePath().normalize()

  override fun assertRealDirectory(path: Path) {
    val target = path.toAbsolutePath().normalize()
    require(target.startsWith(root)) { "Bundle path must stay inside the app-owned root" }
    // Verify every component up to the root rather than letting a directory symlink redirect it.
    generateSequence(target) { it.parent }
      .takeWhile { it.startsWith(root) }
      .forEach(::assertRealDirectoryComponent)
  }

  private fun assertRealDirectoryComponent(path: Path) {
    require(
      Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS).isDirectory,
    ) {
      "Bundle path must be a real directory"
    }
    Files.newDirectoryStream(path).use {
      /* Opening verifies that the checked directory is readable. */
    }
  }

  override fun assertAbsent(path: Path) {
    require(Files.notExists(path, NOFOLLOW_LINKS)) {
      "Bundle destination already exists or cannot be checked"
    }
  }

  override fun makeStagingDirectory(parent: Path, mode: Int): Path =
    Files.createTempDirectory(parent, ".prototype-", permissions(mode))

  override fun mkdir(path: Path, mode: Int) {
    Files.createDirectory(path, permissions(mode))
  }

  override fun writeExclusiveNoFollow(path: Path, bytes: ByteArray) {
    assertRealDirectory(checkNotNull(path.parent))
    Files.newByteChannel(path, setOf(CREATE_NEW, WRITE, NOFOLLOW_LINKS), permissions(384)).use {
      channel ->
      val buffer = ByteBuffer.wrap(bytes)
      while (buffer.hasRemaining()) channel.write(buffer)
    }
  }

  override fun rename(from: Path, to: Path) {
    assertRealDirectory(checkNotNull(from.parent))
    assertRealDirectory(from)
    assertAbsent(to)
    Files.move(from, to, ATOMIC_MOVE)
  }

  override fun remove(path: Path) {
    // walk does not follow links; deleting a hostile link removes the link itself.
    Files.walk(path).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::delete) }
  }

  private fun permissions(mode: Int) =
    PosixFilePermissions.asFileAttribute(
      PosixFilePermissions.fromString(
        when (mode) {
          448 -> "rwx------"
          384 -> "rw-------"
          else -> error("Unsupported bundle mode")
        },
      ),
    )
}
