package dev.jasonpearson.automobile.protocol

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import kotlin.test.*
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assumptions.assumeFalse
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class PrototypeBundleDirectoryFileSystemTest {
  private lateinit var temp: Path
  private lateinit var ancestor: Path
  private lateinit var root: Path

  @BeforeEach
  fun setUp() {
    temp = Files.createTempDirectory("bundle-fs").toRealPath()
    // Like Android's /data/user/0: traversable (x) but not listable (no r) by the app.
    ancestor = Files.createDirectory(temp.resolve("data"))
    root = Files.createDirectories(ancestor.resolve("app/cache/import"))
    Files.setPosixFilePermissions(ancestor, PosixFilePermissions.fromString("--x------"))
  }

  @AfterEach
  fun tearDown() {
    Files.setPosixFilePermissions(ancestor, PosixFilePermissions.fromString("rwx------"))
    Files.walk(temp).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::delete) }
  }

  @Test
  fun `commit succeeds when an ancestor above the app-owned root is not listable`() {
    // Running as root can list anything, so the precondition would not hold.
    assumeFalse(Files.isReadable(ancestor))
    val destination = root.resolve("new-id")
    val result =
      PrototypeBundleCommit.commit(bundle(), destination, PrototypeBundleDirectoryFileSystem(root))
    assertEquals(PrototypeBundleCommitResult.Success(destination), result)
    assertTrue(Files.isRegularFile(destination.resolve("spec.json")))
  }

  @Test
  fun `directory symlink below the root is still rejected`() {
    val elsewhere = Files.createDirectory(temp.resolve("elsewhere"))
    val link = Files.createSymbolicLink(root.resolve("link"), elsewhere)
    val result =
      PrototypeBundleCommit.commit(
        bundle(),
        link.resolve("new-id"),
        PrototypeBundleDirectoryFileSystem(root),
      )
    assertIs<PrototypeBundleCommitResult.Failure>(result)
    assertFalse(Files.exists(elsewhere.resolve("new-id")))
  }

  @Test
  fun `paths outside the app-owned root are rejected`() {
    val fs = PrototypeBundleDirectoryFileSystem(root)
    assertFailsWith<IllegalArgumentException> { fs.assertRealDirectory(temp) }
    assertFailsWith<IllegalArgumentException> { fs.assertRealDirectory(root.resolve("../..")) }
  }

  private fun bundle(): PrototypeBundle =
    assertIs<PrototypeBundleReadResult.Success>(
        PrototypeBundleReader.read(PrototypeBundleCorpus.cases.first().bytes),
      )
      .bundle
}
