package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.sha256Hex
import dev.jasonpearson.automobile.protocol.PrototypeBundle
import dev.jasonpearson.automobile.protocol.PrototypeBundleCommitFileSystem
import dev.jasonpearson.automobile.protocol.PrototypeBundleReadResult
import dev.jasonpearson.automobile.protocol.PrototypeBundleReader
import java.nio.file.Path
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

/**
 * A Hide confirmed while an import of the same content is staging leaves nothing stored (#16669).
 */
class ImportHideRaceTest {
  private val metadata = FakeLibraryFiles()
  private val store = FakeSavedStore()
  private val blocklist = FakeContentBlocklist()
  private val staging = PausingCommitFiles()
  private val library =
    DirectoryLibraryRepository(
      store,
      metadata,
      LibraryStorage(FakePrototypeStorage()),
      IdGenerator { "00000000-0000-4000-8000-000000000001" },
      LibraryClock { 42 },
      blocklist.admission(),
    )
  private val repository = BlocklistLibraryRepository(library, blocklist)
  private val commit =
    DirectoryLibraryImport(
      library,
      Path.of("/import"),
      staging,
      IdGenerator { "00000000-0000-4000-8000-0000000000ff" },
      blocklist,
    )

  @Test
  fun hideAndPurgeDuringStagingEndWithNothingStored() {
    var result: LibraryResult<LibraryEntry>? = null
    val importer = Thread { result = commit.commit(bundle, LibrarySource.share, null, null) }
    importer.start()
    assertTrue(staging.entered.await(5, TimeUnit.SECONDS))

    // The importer's early check already passed; Hide and its purge land mid-import.
    blocklist.hide(specSha256)
    assertEquals(
      emptyList<LibraryEntry>(),
      (repository.purgeBlocked() as LibraryResult.Success).value,
    )
    staging.release.countDown()
    importer.join(5_000)

    assertEquals(LibraryResult.Failure(LibraryError.Hidden), result)
    assertTrue(metadata.documents.isEmpty())
    assertTrue(store.results.isEmpty())
    assertEquals(emptyList<LibraryEntry>(), (library.list() as LibraryResult.Success).value)
  }

  @Test
  fun hiddenImportIsStillRejectedBeforeStaging() {
    blocklist.hide(specSha256)
    staging.release.countDown()

    assertEquals(
      LibraryResult.Failure(LibraryError.Hidden),
      commit.commit(bundle, LibrarySource.file, null, null),
    )
    assertEquals(1L, staging.entered.count)
    assertTrue(store.results.isEmpty())
  }

  @Test
  fun ownPrototypesAreAdmittedWhateverTheBlocklistHolds() {
    blocklist.hide(specSha256)
    staging.release.countDown()

    assertTrue(commit.commit(bundle, LibrarySource.mcp, null, null) is LibraryResult.Success)
  }

  /** Pauses the importer as staging starts, after its early blocklist check. */
  private class PausingCommitFiles : PrototypeBundleCommitFileSystem {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)

    override fun assertRealDirectory(path: Path) = Unit

    override fun assertAbsent(path: Path) = Unit

    override fun makeStagingDirectory(parent: Path, mode: Int): Path {
      entered.countDown()
      check(release.await(5, TimeUnit.SECONDS)) { "Staging was never released" }
      return parent.resolve(".stage")
    }

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
    private val specSha256: String by lazy {
      sha256Hex(bundle.spec.toString(Charsets.UTF_8).toByteArray())
    }

    @JvmStatic
    @BeforeClass
    fun warm() {
      Fixtures.spec
      specSha256
    }
  }
}
