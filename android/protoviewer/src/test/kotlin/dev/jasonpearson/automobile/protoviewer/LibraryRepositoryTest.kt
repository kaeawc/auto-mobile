package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeLoadResult
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeSaveRequest
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import java.io.IOException
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test

class LibraryRepositoryTest {
  private val files = FakeLibraryFiles()
  private val store = FakeSavedStore()
  private val diskStorage = FakePrototypeStorage()
  private val storage = LibraryStorage(diskStorage)
  private var now = 42L
  private val ids = ArrayDeque(listOf(FIRST, SECOND))
  private val repository =
    DirectoryLibraryRepository(
      store,
      files,
      storage,
      IdGenerator { ids.removeFirst() },
      LibraryClock { now },
    )

  @Before
  fun seed() {
    files.put(Fixtures.entry())
    store.results[FIRST] = Fixtures.loaded()
  }

  @Test
  fun listOrdersByLastOpenedDescending() {
    files.put(Fixtures.entry(SECOND, 12))
    assertEquals(listOf(SECOND, FIRST), success(repository.list()).map { it.libraryId })
  }

  @Test
  fun corruptAndUnreadableMetadataAreSkipped() {
    files.documents[SECOND] = "not json"
    files.documents["00000000-0000-4000-8000-000000000003"] = "{}"
    files.put(Fixtures.entry("00000000-0000-4000-8000-000000000004"))
    files.unreadable += "00000000-0000-4000-8000-000000000004"
    assertEquals(listOf(FIRST), success(repository.list()).map { it.libraryId })
  }

  @Test
  fun unknownMetadataKeysAreRejected() {
    files.documents[SECOND] =
      files.documents.getValue(FIRST).replace(FIRST, SECOND).dropLast(1) + ",\"trust\":true}"
    assertEquals(1, success(repository.list()).size)
  }

  @Test
  fun mismatchedLibraryIdentityIsSkipped() {
    files.documents[SECOND] = files.documents.getValue(FIRST)
    assertEquals(1, success(repository.list()).size)
  }

  @Test
  fun markOpenedUsesInjectedClockAndPreservesMetadata() {
    val before = success(repository.get(FIRST)).entry
    assertEquals(LibraryResult.Success(Unit), repository.markOpened(FIRST))
    assertEquals(before.copy(lastOpenedAt = 42), success(repository.get(FIRST)).entry)
  }

  @Test
  fun sameSpecGetsFreshLibraryIdsAndIndependentStorage() {
    files.documents.clear()
    store.results.clear()
    val request = SavedPrototypeSaveRequest("same-spec-id", "Example", SPEC, emptyList())
    val first = success(repository.add(request, LibrarySource.file))
    val second = success(repository.add(request, LibrarySource.paste))
    assertEquals(FIRST, first.libraryId)
    assertEquals(SECOND, second.libraryId)
    val a = storage.namespace(first.libraryId)
    val b = storage.namespace(second.libraryId)
    a.save("same-spec-id", VALUES)
    assertEquals(VALUES, a.load("same-spec-id"))
    assertNull(b.load("same-spec-id"))
    assertEquals("same-spec-id", success(repository.get(SECOND)).saved.spec.id)
  }

  @Test
  fun resetClearsOnlyThatIdAndPreventsOldRuntimeWrites() {
    files.put(Fixtures.entry(SECOND))
    val stale = storage.namespace(FIRST)
    stale.save("same-spec-id", VALUES)
    storage.namespace(SECOND).save("same-spec-id", VALUES)
    assertEquals(LibraryResult.Success(Unit), repository.resetStorage(FIRST))
    stale.save("same-spec-id", VALUES)
    assertNull(storage.namespace(FIRST).load("same-spec-id"))
    assertEquals(VALUES, storage.namespace(SECOND).load("same-spec-id"))
    assertEquals(2, success(repository.list()).size)
  }

  @Test
  fun deleteIsNotPartOfThisSlice() {
    assertFalse(LibraryRepository::class.java.methods.any { it.name == "delete" })
  }

  @Test
  fun libraryCapIsWiredToSavedStoreLimits() {
    assertEquals(200, MAX_LIBRARY_PROTOTYPES)
    assertEquals(MAX_LIBRARY_PROTOTYPES, libraryLimits.maxSavedPrototypes)
  }

  @Test
  fun capRejectsCommitBeforeGeneratingId() {
    repeat(MAX_LIBRARY_PROTOTYPES) {
      files.put(Fixtures.entry("00000000-0000-4000-8000-${it.toString().padStart(12, '0')}"))
    }
    assertEquals(
      LibraryResult.Failure(LibraryError.Limit),
      repository.add(
        SavedPrototypeSaveRequest("ignored", "Example", SPEC, emptyList()),
        LibrarySource.file,
      ),
    )
    assertEquals(2, ids.size)
  }

  @Test
  fun listIoErrorsAreTyped() {
    files.fail = true
    assertEquals(LibraryResult.Failure(LibraryError.Storage), repository.list())
  }

  @Test
  fun metadataWriteErrorsAreTyped() {
    val failing =
      object : LibraryFileOperations by files {
        override fun write(id: String, text: String) {
          throw IOException("Cannot write")
        }
      }
    val target = DirectoryLibraryRepository(store, failing, storage)
    assertEquals(LibraryResult.Failure(LibraryError.Storage), target.markOpened(FIRST))
  }

  @Test
  fun storeReadErrorsAreTyped() {
    val failing =
      object : dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeStore by store {
        override fun load(id: String): SavedPrototypeLoadResult = throw IOException("Unavailable")
      }
    val target = DirectoryLibraryRepository(failing, files, storage)
    assertEquals(LibraryResult.Failure(LibraryError.Storage), target.get(FIRST))
  }

  @Test
  fun resetFailureIsTypedAndKeepsExistingStorageGeneration() {
    val failing =
      object : dev.jasonpearson.automobile.prototype.PrototypeStorage by diskStorage {
        override fun delete(id: String) {
          throw IOException("Cannot delete")
        }
      }
    val targetStorage = LibraryStorage(failing)
    val namespace = targetStorage.namespace(FIRST)
    namespace.save("same-spec-id", VALUES)
    val target = DirectoryLibraryRepository(store, files, targetStorage)
    assertEquals(LibraryResult.Failure(LibraryError.Storage), target.resetStorage(FIRST))
    assertEquals(VALUES, namespace.load("same-spec-id"))
  }

  @Test
  fun metadataCommitFailureRollsBackSavedEntry() {
    val failing =
      object : LibraryFileOperations by files {
        override fun write(id: String, text: String) {
          throw IOException("Cannot commit")
        }
      }
    val target =
      DirectoryLibraryRepository(
        store,
        failing,
        storage,
        IdGenerator { SECOND },
        LibraryClock { now },
      )
    assertEquals(
      LibraryResult.Failure(LibraryError.Storage),
      target.add(
        SavedPrototypeSaveRequest("ignored", "Example", SPEC, emptyList()),
        LibrarySource.file,
      ),
    )
    assertEquals(SavedPrototypeLoadResult.NotFound, store.load(SECOND))
    assertEquals(listOf(FIRST), success(target.list()).map { it.libraryId })
  }

  @Test
  fun notFoundCorruptAndUnsupportedHaveErrorScreenStates() {
    assertEquals(ViewerScreenState.Error(LibraryError.NotFound), loadViewer(SECOND, repository))
    store.results[FIRST] = SavedPrototypeLoadResult.Corrupt("Secret disk path")
    assertEquals(ViewerScreenState.Error(LibraryError.Corrupt), loadViewer(FIRST, repository))
    store.results[FIRST] = SavedPrototypeLoadResult.UnsupportedFormat(99)
    assertEquals(
      ViewerScreenState.Error(LibraryError.UnsupportedFormat),
      loadViewer(FIRST, repository),
    )
  }

  @Test
  fun unsupportedCapabilitiesDoNotRender() {
    files.put(Fixtures.entry().copy(requires = listOf("future_feature")))
    assertEquals(LibraryResult.Failure(LibraryError.UnsupportedFormat), repository.get(FIRST))
  }

  @Test
  fun hashMismatchDoesNotRender() {
    files.put(Fixtures.entry().copy(specSha256 = "0".repeat(64)))
    assertEquals(LibraryResult.Failure(LibraryError.Corrupt), repository.get(FIRST))
  }

  @Test
  fun missingIdDoesNotTouchStorage() {
    assertEquals(ViewerScreenState.Error(LibraryError.NotFound), loadViewer(null, repository))
    assertEquals(LibraryResult.Failure(LibraryError.NotFound), repository.resetStorage("../escape"))
  }

  @Test
  fun privilegedWindowsAreRejectedBeforeCommit() {
    val spec = SPEC.replace("\"placement\":", "\"layer\":\"system\",\"placement\":")
    assertEquals(
      LibraryResult.Failure(LibraryError.Invalid),
      repository.add(
        SavedPrototypeSaveRequest("ignored", "Example", spec, emptyList()),
        LibrarySource.file,
      ),
    )
  }

  @Test
  fun hostRequestsAreRejectedBeforeCommit() {
    val spec =
      """{"id":"host","window":{"placement":{"type":"fullscreen"}},"root":{"type":"button","label":"Load","onTap":[{"type":"request","url":"https://example.com","via":"host"}]}}"""
    assertEquals(
      LibraryResult.Failure(LibraryError.Invalid),
      repository.add(
        SavedPrototypeSaveRequest("ignored", "Example", spec, emptyList()),
        LibrarySource.file,
      ),
    )
  }

  private fun <T> success(result: LibraryResult<T>): T = (result as LibraryResult.Success).value

  companion object {
    private val VALUES = PrototypeStoredValues(1, mapOf("value" to JsonPrimitive("kept")))

    @JvmStatic
    @BeforeClass
    fun warmValidation() {
      Fixtures.spec
    }
  }
}
