package dev.jasonpearson.automobile.protoviewer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ContentBlocklistTest {
  private val library = FakeLibraryRepository()
  private val blocklist = FakeContentBlocklist()
  private val repository = BlocklistLibraryRepository(library, blocklist)

  private fun put(id: String, source: LibrarySource, host: String? = null, hash: String = HASH) {
    val base = Fixtures.prototype(id)
    library.prototypes[id] =
      base.copy(entry = base.entry.copy(source = source, sourceHost = host, specSha256 = hash))
  }

  @Test
  fun hiddenSpecHashRemovesReceivedCopiesFromListAndGet() {
    put(FIRST, LibrarySource.file)
    put(SECOND, LibrarySource.share, hash = OTHER_HASH)
    blocklist.hide(HASH)
    assertEquals(
      listOf(SECOND),
      (repository.list() as LibraryResult.Success).value.map { it.libraryId },
    )
    assertEquals(LibraryResult.Failure(LibraryError.NotFound), repository.get(FIRST))
    assertTrue(repository.get(SECOND) is LibraryResult.Success)
  }

  @Test
  fun blockedHostRemovesEveryPrototypeFromThatHostOnly() {
    put(FIRST, LibrarySource.share, host = "proto.example.com", hash = OTHER_HASH)
    put(SECOND, LibrarySource.share, host = "other.example.com", hash = OTHER_HASH)
    blocklist.block("proto.example.com")
    assertEquals(
      listOf(SECOND),
      (repository.list() as LibraryResult.Success).value.map { it.libraryId },
    )
    assertEquals(LibraryResult.Failure(LibraryError.NotFound), repository.get(FIRST))
  }

  @Test
  fun theUsersOwnPrototypesAreNeverHidden() {
    put(FIRST, LibrarySource.mcp)
    put(SECOND, LibrarySource.paste)
    blocklist.hide(HASH)
    assertEquals(2, (repository.list() as LibraryResult.Success).value.size)
    assertTrue(repository.get(FIRST) is LibraryResult.Success)
  }

  @Test
  fun failuresAndOtherOperationsPassThrough() {
    library.error = LibraryError.Storage
    assertEquals(LibraryResult.Failure(LibraryError.Storage), repository.list())
    assertEquals(LibraryResult.Failure(LibraryError.Storage), repository.get(FIRST))
    library.error = null
    repository.resetStorage(FIRST)
    assertEquals(listOf(FIRST), library.resets)
  }

  @Test
  fun purgeDeletesHiddenAndBlockedReceivedEntriesOnly() {
    put(FIRST, LibrarySource.file)
    put(SECOND, LibrarySource.share, host = "proto.example.com", hash = OTHER_HASH)
    put(THIRD, LibrarySource.mcp)
    put(FOURTH, LibrarySource.share, hash = OTHER_HASH)
    blocklist.hide(HASH)
    blocklist.block("proto.example.com")
    assertEquals(
      setOf(FIRST, SECOND),
      (repository.purgeBlocked() as LibraryResult.Success).value.map { it.libraryId }.toSet(),
    )
    assertEquals(setOf(THIRD, FOURTH), library.prototypes.keys)
  }

  @Test
  fun purgeReportsOnlyDeletedEntriesAndPassesListFailuresThrough() {
    put(FIRST, LibrarySource.file)
    blocklist.hide(HASH)
    library.failDelete = true
    assertEquals(
      emptyList<LibraryEntry>(),
      (repository.purgeBlocked() as LibraryResult.Success).value,
    )
    assertEquals(LibraryResult.Failure(LibraryError.NotFound), repository.get(FIRST))
    library.failDelete = false
    library.error = LibraryError.Storage
    assertEquals(LibraryResult.Failure(LibraryError.Storage), repository.purgeBlocked())
  }

  @Test
  fun rejectsMatchesHiddenHashesAndBlockedHostsForReceivedSourcesOnly() {
    blocklist.hide(HASH)
    blocklist.block("proto.example.com")
    assertTrue(blocklist.rejects(LibrarySource.file, HASH))
    assertTrue(blocklist.rejects(LibrarySource.share, OTHER_HASH, "proto.example.com"))
    assertFalse(blocklist.rejects(LibrarySource.share, OTHER_HASH))
    assertFalse(blocklist.rejects(LibrarySource.mcp, HASH))
    assertFalse(blocklist.rejects(LibrarySource.paste, HASH, "proto.example.com"))
  }

  @Test
  fun sourceHostAcceptsOnlyLowercaseDnsNames() {
    assertTrue(validSourceHost("proto.example.com"))
    assertTrue(validSourceHost("a-b.example.io"))
    listOf(
        "Proto.example.com",
        "localhost",
        "10.0.2.2",
        "example.com:443",
        "user@example.com",
        "-bad.example.com",
        "exa mple.com",
        "",
      )
      .forEach { assertFalse(it, validSourceHost(it)) }
  }

  private companion object {
    const val THIRD = "00000000-0000-4000-8000-000000000003"
    const val FOURTH = "00000000-0000-4000-8000-000000000004"
    val HASH = Fixtures.entry().specSha256
    val OTHER_HASH = "b".repeat(64)
  }
}
