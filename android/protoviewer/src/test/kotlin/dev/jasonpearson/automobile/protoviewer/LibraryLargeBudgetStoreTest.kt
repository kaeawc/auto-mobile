package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeLoadResult
import dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeSaveRequest
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** A large-budget import saves and reloads through the real directory store (#18804). */
class LibraryLargeBudgetStoreTest {
  @get:Rule val temp = TemporaryFolder()

  @Test
  fun largeBudgetSpecSavesAndReloadsThroughTheDirectoryStore() {
    val root = File(temp.root, "prototypes")
    val repository =
      DirectoryLibraryRepository(
        librarySavedStore(root),
        FakeLibraryFiles(),
        LibraryStorage(FakePrototypeStorage()),
        IdGenerator { FIRST },
        LibraryClock { 42L },
      )
    val request = SavedPrototypeSaveRequest("feed", "Feed", feedSpec(2001), emptyList())
    val added = repository.add(request, LibrarySource.file)
    assertTrue("$added", added is LibraryResult.Success)
    // A fresh store instance reloads (and revalidates) the saved spec with the same budget.
    assertTrue(librarySavedStore(root).load(FIRST) is SavedPrototypeLoadResult.Loaded)
  }

  @Test
  fun specOverTheBaseByteCapSavesAndReloads() {
    val root = File(temp.root, "prototypes")
    val repository =
      DirectoryLibraryRepository(
        librarySavedStore(root),
        FakeLibraryFiles(),
        LibraryStorage(FakePrototypeStorage()),
        IdGenerator { FIRST },
        LibraryClock { 42L },
      )
    // Over the base 1 MiB spec cap, within the large budget's 4 MiB.
    val spec = feedSpec(1, blob = "x".repeat(1024 * 1024 + 4096))
    val added =
      repository.add(SavedPrototypeSaveRequest("big", "Big", spec, emptyList()), LibrarySource.file)
    assertTrue("$added", added is LibraryResult.Success)
    assertTrue(librarySavedStore(root).load(FIRST) is SavedPrototypeLoadResult.Loaded)
  }

  @Test
  fun overTheLargeBudgetIsStillRefused() {
    val repository =
      DirectoryLibraryRepository(
        librarySavedStore(File(temp.root, "prototypes")),
        FakeLibraryFiles(),
        LibraryStorage(FakePrototypeStorage()),
        IdGenerator { FIRST },
        LibraryClock { 42L },
      )
    val request = SavedPrototypeSaveRequest("feed", "Feed", feedSpec(10_001), emptyList())
    assertEquals(
      false,
      repository.add(request, LibrarySource.file) is LibraryResult.Success,
    )
  }

  private fun feedSpec(rows: Int, blob: String? = null): String {
    val items = (0 until rows).joinToString(",") { """{"id":$it}""" }
    val extra = blob?.let { ""","blob":"$it"""" }.orEmpty()
    return """{"id":"feed","window":{"placement":{"type":"fullscreen"}},""" +
      """"root":{"type":"list","repeat":{"items":{"path":"/feed/items"},"as":"post","key":"id"},""" +
      """"children":[{"type":"text","text":"{post.id}"}]},"data":{"feed":{"items":[$items]}$extra}}"""
  }
}
