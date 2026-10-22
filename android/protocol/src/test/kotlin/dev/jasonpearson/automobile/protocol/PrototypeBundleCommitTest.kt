package dev.jasonpearson.automobile.protocol

import java.nio.file.Path
import kotlin.test.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeBundleCommitTest {
  companion object {
    private val parent = Path.of("/library")
    private val destination = parent.resolve("new-id")
    private lateinit var bundle: PrototypeBundle

    @JvmStatic
    @BeforeAll
    fun prepare() {
      bundle =
        assertIs<PrototypeBundleReadResult.Success>(
            PrototypeBundleReader.read(PrototypeBundleCorpus.cases.first().bytes),
          )
          .bundle
    }
  }

  @Test
  fun `commit publishes canonical files with one rename and private directories`() {
    val fs = FakeFileSystem()
    assertEquals(
      PrototypeBundleCommitResult.Success(destination),
      PrototypeBundleCommit.commit(bundle, destination, fs),
    )
    assertEquals(listOf(448, 448, 448), fs.modes)
    assertEquals(listOf("bundle.json", "spec.json"), fs.files.keys.map { it.fileName.toString() })
    assertEquals(1, fs.renames)
    assertFalse(fs.removed)
    assertTrue(fs.events.last() == "rename")
  }

  @Test
  fun `write failure removes staging without publishing`() {
    val fs = FakeFileSystem(failOn = "write")
    assertIs<PrototypeBundleCommitResult.Failure>(
      PrototypeBundleCommit.commit(bundle, destination, fs),
    )
    assertTrue(fs.removed)
    assertEquals(0, fs.renames)
  }

  @Test
  fun `rename failure removes staging`() {
    val fs = FakeFileSystem(failOn = "rename")
    assertIs<PrototypeBundleCommitResult.Failure>(
      PrototypeBundleCommit.commit(bundle, destination, fs),
    )
    assertTrue(fs.removed)
  }

  @Test
  fun `directory symlink and occupied destination reject before staging`() {
    for (failure in listOf("directory", "absent")) {
      val fs = FakeFileSystem(failOn = failure)
      assertIs<PrototypeBundleCommitResult.Failure>(
        PrototypeBundleCommit.commit(bundle, destination, fs),
      )
      assertTrue(fs.modes.isEmpty())
      assertEquals(0, fs.renames)
    }
  }

  @Test
  fun `mutable spec is revalidated before disk writes`() {
    val fs = FakeFileSystem()
    assertIs<PrototypeBundleCommitResult.Failure>(
      PrototypeBundleCommit.commit(bundle.copy(spec = "{}".toByteArray()), destination, fs),
    )
    assertTrue(fs.modes.isEmpty())
    assertTrue(fs.files.isEmpty())
  }

  @Test
  fun `unsafe adapter staging path is never written or removed`() {
    val fs = FakeFileSystem(fresh = Path.of("/outside/stage"))
    assertIs<PrototypeBundleCommitResult.Failure>(
      PrototypeBundleCommit.commit(bundle, destination, fs),
    )
    assertTrue(fs.files.isEmpty())
    assertFalse(fs.removed)
  }

  @Test
  fun `destination is rechecked after writes and cleanup failures remain visible`() {
    val fs = FakeFileSystem(failOn = "absent-again", failCleanup = true)
    val result =
      assertIs<PrototypeBundleCommitResult.Failure>(
        PrototypeBundleCommit.commit(bundle, destination, fs),
      )
    assertTrue(result.cleanupFailed)
    assertEquals(0, fs.renames)
  }

  private class FakeFileSystem(
    private val failOn: String? = null,
    private val failCleanup: Boolean = false,
    private val fresh: Path = parent.resolve("stage"),
  ) : PrototypeBundleCommitFileSystem {
    val modes = mutableListOf<Int>()
    val events = mutableListOf<String>()
    val files = linkedMapOf<Path, ByteArray>()
    var renames = 0
    var removed = false
    private var absentCalls = 0

    private fun event(name: String) {
      events.add(name)
      check(name != failOn) { "injected failure" }
    }

    override fun assertRealDirectory(path: Path) {
      event("directory")
    }

    override fun assertAbsent(path: Path) {
      event(if (absentCalls++ == 0) "absent" else "absent-again")
    }

    override fun makeStagingDirectory(parent: Path, mode: Int): Path {
      event("stage")
      modes.add(mode)
      return fresh
    }

    override fun mkdir(path: Path, mode: Int) {
      event("mkdir")
      modes.add(mode)
    }

    override fun writeExclusiveNoFollow(path: Path, bytes: ByteArray) {
      event("write")
      check(path !in files)
      files[path] = bytes.copyOf()
    }

    override fun rename(from: Path, to: Path) {
      event("rename")
      renames++
    }

    override fun remove(path: Path) {
      removed = true
      check(!failCleanup)
      event("remove")
    }
  }
}
