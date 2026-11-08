package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.sha256Hex
import dev.jasonpearson.automobile.protocol.PrototypeBundle
import dev.jasonpearson.automobile.protocol.PrototypeBundleCommitFileSystem
import dev.jasonpearson.automobile.protocol.PrototypeBundleReadResult
import dev.jasonpearson.automobile.protocol.PrototypeBundleReader
import java.nio.file.Path
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

/** Hidden or blocked received content never holds library quota (#16631). */
class HiddenContentQuotaTest {
  private val metadata = FakeLibraryFiles()
  private val store = FakeSavedStore()
  private val blocklist = FakeContentBlocklist()
  private val ids = ArrayDeque(listOf(FIRST, SECOND))
  private val library =
    DirectoryLibraryRepository(
      store,
      metadata,
      LibraryStorage(FakePrototypeStorage()),
      IdGenerator { ids.removeFirst() },
      LibraryClock { 42 },
    )
  private val repository = BlocklistLibraryRepository(library, blocklist)
  private val commit =
    DirectoryLibraryImport(
      library,
      Path.of("/import"),
      NoOpCommitFiles,
      IdGenerator { "00000000-0000-4000-8000-0000000000ff" },
      blocklist,
    )

  @Test
  fun aFullLibraryOfHiddenContentFreesItsQuotaForTheNextImport() {
    repeat(MAX_LIBRARY_PROTOTYPES) {
      val id = "00000000-0000-4000-8000-1${it.toString().padStart(11, '0')}"
      metadata.put(Fixtures.entry(id))
      store.results[id] = Fixtures.loaded(id)
    }
    assertEquals(
      LibraryResult.Failure(LibraryError.Limit),
      commit.commit(bundle, LibrarySource.share, null, null),
    )

    blocklist.hide(Fixtures.entry().specSha256)
    assertEquals(
      MAX_LIBRARY_PROTOTYPES,
      (repository.purgeBlocked() as LibraryResult.Success).value.size,
    )

    assertTrue(metadata.documents.isEmpty())
    assertTrue(commit.commit(bundle, LibrarySource.share, null, null) is LibraryResult.Success)
    assertEquals(
      listOf(FIRST),
      (repository.list() as LibraryResult.Success).value.map { it.libraryId },
    )
  }

  @Test
  fun reimportingHiddenContentStoresNothing() {
    commit.commit(bundle, LibrarySource.file, null, null)
    blocklist.hide(sha256Hex(bundle.spec.toString(Charsets.UTF_8).toByteArray()))
    repository.purgeBlocked()

    assertEquals(
      LibraryResult.Failure(LibraryError.Hidden),
      commit.commit(bundle, LibrarySource.file, null, null),
    )
    assertTrue(metadata.documents.isEmpty())
    assertTrue(store.results.isEmpty())
    assertEquals(listOf(SECOND), ids.toList())
  }

  private object NoOpCommitFiles : PrototypeBundleCommitFileSystem {
    override fun assertRealDirectory(path: Path) = Unit

    override fun assertAbsent(path: Path) = Unit

    override fun makeStagingDirectory(parent: Path, mode: Int): Path = parent.resolve(".stage")

    override fun mkdir(path: Path, mode: Int) = Unit

    override fun writeExclusiveNoFollow(path: Path, bytes: ByteArray) = Unit

    override fun rename(from: Path, to: Path) = Unit

    override fun remove(path: Path) = Unit
  }

  companion object {
    private val bundle: PrototypeBundle by lazy {
      (PrototypeBundleReader.read(ImportBundleFixtures.minimal)
          as PrototypeBundleReadResult.Success)
        .bundle
    }

    @JvmStatic
    @BeforeClass
    fun warm() {
      Fixtures.spec
      bundle
    }
  }
}
