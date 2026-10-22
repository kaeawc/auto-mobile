package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.protocol.PrototypeBundleCommitFileSystem
import dev.jasonpearson.automobile.protocol.PrototypeBundleReadResult
import dev.jasonpearson.automobile.protocol.PrototypeBundleReader
import java.io.IOException
import java.nio.file.Path
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class DirectoryLibraryImportTest {
  private val metadata = FakeLibraryFiles()
  private val store = FakeSavedStore()
  private val storage = FakePrototypeStorage()
  private val repository =
    DirectoryLibraryRepository(
      store,
      metadata,
      LibraryStorage(storage),
      IdGenerator { FIRST },
      LibraryClock { 42 },
    )
  private val files = FakeCommitFiles()
  private val commit =
    DirectoryLibraryImport(repository, Path.of("/import"), files, IdGenerator { SECOND })
  private val bundle =
    (PrototypeBundleReader.read(ImportBundleFixtures.minimal) as PrototypeBundleReadResult.Success)
      .bundle

  @Test
  fun stagedBundleCommitsIntoAppGeneratedLibraryIdentity() {
    val entry = (commit.commit(bundle, LibrarySource.share) as LibraryResult.Success).value
    assertEquals(FIRST, entry.libraryId)
    assertEquals(LibrarySource.share, entry.source)
    assertEquals(42L, entry.importedAt)
    assertEquals(Path.of("/import/$SECOND"), files.renamedTo)
    assertTrue(files.documents.isEmpty())
    assertTrue(storage.values.isEmpty())
    assertTrue(store.results.containsKey(FIRST))
  }

  @Test
  fun failedStageChangesNoLibraryEntryAndCleansStage() {
    files.failWrite = true
    assertEquals(
      LibraryResult.Failure(LibraryError.Storage),
      commit.commit(bundle, LibrarySource.file),
    )
    assertTrue(metadata.documents.isEmpty())
    assertTrue(store.results.isEmpty())
    assertTrue(files.documents.isEmpty())
    assertNull(files.renamedTo)
  }

  @Test
  fun failedMetadataRollsBackSaveAndRemovesTransportStage() {
    val failingMetadata =
      object : LibraryFileOperations by metadata {
        override fun write(id: String, text: String) {
          throw IOException("Cannot commit metadata")
        }
      }
    val targetRepository =
      DirectoryLibraryRepository(
        store,
        failingMetadata,
        LibraryStorage(storage),
        IdGenerator { FIRST },
        LibraryClock { 42 },
      )
    val target =
      DirectoryLibraryImport(targetRepository, Path.of("/import"), files, IdGenerator { SECOND })
    assertEquals(
      LibraryResult.Failure(LibraryError.Storage),
      target.commit(bundle, LibrarySource.file),
    )
    assertTrue(store.results.isEmpty())
    assertTrue(files.documents.isEmpty())
  }

  private class FakeCommitFiles : PrototypeBundleCommitFileSystem {
    val documents = mutableMapOf<Path, ByteArray>()
    var renamedTo: Path? = null
    var failWrite = false

    override fun assertRealDirectory(path: Path) = Unit

    override fun assertAbsent(path: Path) {
      check(documents.keys.none { it.startsWith(path) })
    }

    override fun makeStagingDirectory(parent: Path, mode: Int): Path = parent.resolve(".stage")

    override fun mkdir(path: Path, mode: Int) = Unit

    override fun writeExclusiveNoFollow(path: Path, bytes: ByteArray) {
      if (failWrite) throw IOException("Cannot write staging file")
      check(documents.put(path, bytes) == null)
    }

    override fun rename(from: Path, to: Path) {
      renamedTo = to
      val moving = documents.toMap()
      documents.clear()
      moving.forEach { (path, bytes) -> documents[to.resolve(from.relativize(path))] = bytes }
    }

    override fun remove(path: Path) {
      documents.keys.removeAll { it.startsWith(path) }
    }
  }

  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      Fixtures.spec
      PrototypeBundleReader.read(ImportBundleFixtures.minimal)
    }
  }
}
