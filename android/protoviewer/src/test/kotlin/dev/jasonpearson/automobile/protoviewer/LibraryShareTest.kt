package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.protocol.PrototypeBundleReadResult
import dev.jasonpearson.automobile.protocol.PrototypeBundleReader
import java.io.IOException
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

internal class FakeExportFiles : LibraryExportFiles {
  val files = mutableMapOf<String, ByteArray>()
  var fail = false
  var clears = 0

  override fun write(name: String, bytes: ByteArray) {
    files[name] = bytes
    if (fail) throw IOException("Partial write")
  }

  override fun delete(name: String) {
    files.remove(name)
  }

  override fun clear() {
    files.clear()
    clears++
  }
}

class LibraryShareTest {
  private val repository =
    FakeLibraryRepository().apply { prototypes[FIRST] = Fixtures.prototype() }
  private val files = FakeExportFiles()
  private val share = CanonicalLibrarySharer(repository, files, IdGenerator { SECOND })

  @Test
  fun canonicalShareContainsOnlySpecAndReferencedAssets() {
    val export = (share.prepare(FIRST) as LibraryResult.Success).value
    assertEquals("$SECOND.automobile-proto", export.name)
    val bytes = files.files.getValue(export.name)
    val read = PrototypeBundleReader.read(bytes) as PrototypeBundleReadResult.Success
    assertEquals(SPEC, read.bundle.spec.toString(Charsets.UTF_8))
    assertTrue(read.bundle.assets.isEmpty())
    assertFalse(bytes.toString(Charsets.ISO_8859_1).contains("library.json"))
    assertFalse(bytes.toString(Charsets.ISO_8859_1).contains("lastOpenedAt"))
    assertFalse(bytes.toString(Charsets.ISO_8859_1).contains(FIRST))
    assertEquals(LibraryResult.Success(Unit), share.cleanup(export.name))
    assertTrue(files.files.isEmpty())
  }

  @Test
  fun exportDropsUnreferencedSnapshotAssetsAndPreservesReferencedImageAndFont() {
    val bundle =
      (PrototypeBundleReader.read(ImportBundleFixtures.imageFont)
          as PrototypeBundleReadResult.Success)
        .bundle
    val assets =
      (bundle.assets + bundle.fonts).mapValues { it.value.bytes } +
        ("unreferenced" to byteArrayOf(1))
    val loaded =
      dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeLoadResult.Loaded(
        FIRST,
        "Example",
        "slug",
        0,
        Fixtures.spec,
        bundle.spec.toString(Charsets.UTF_8),
        assets,
      )
    repository.prototypes[FIRST] = LibraryPrototype(Fixtures.entry(), loaded)
    val export = (share.prepare(FIRST) as LibraryResult.Success).value
    val result =
      (PrototypeBundleReader.read(files.files.getValue(export.name))
          as PrototypeBundleReadResult.Success)
        .bundle
    assertEquals(bundle.assets.keys, result.assets.keys)
    assertEquals(bundle.fonts.keys, result.fonts.keys)
    assertFalse(result.assets.containsKey("unreferenced"))
    assertArrayEquals(bundle.spec, result.spec)
  }

  @Test
  fun partialWriteIsCleanedOnFailure() {
    files.fail = true
    assertEquals(LibraryResult.Failure(LibraryError.Storage), share.prepare(FIRST))
    assertTrue(files.files.isEmpty())
  }

  @Test
  fun startupClearsStaleExports() {
    files.files["stale.automobile-proto"] = byteArrayOf(1)
    assertEquals(LibraryResult.Success(Unit), share.clearStale())
    assertTrue(files.files.isEmpty())
    assertEquals(1, files.clears)
  }

  @Test
  fun missingPrototypeDoesNotWriteExport() {
    assertEquals(LibraryResult.Failure(LibraryError.NotFound), share.prepare(SECOND))
    assertTrue(files.files.isEmpty())
  }

  @Test
  fun sensitiveSpecProducesPreflightWarningWithoutRedactingBytes() {
    val raw =
      """{"id":"network","window":{"placement":{"type":"fullscreen"}},"root":{"type":"button","label":"Load","onTap":[{"type":"request","url":"https://localhost/path?token=secret","via":"device","headers":{"Authorization":"secret"}}]}}"""
    val loaded =
      dev.jasonpearson.automobile.ctrlproxy.prototype.SavedPrototypeLoadResult.Loaded(
        FIRST,
        "Example",
        "slug",
        0,
        Fixtures.spec,
        raw,
        emptyMap(),
      )
    repository.prototypes[FIRST] = LibraryPrototype(Fixtures.entry(), loaded)
    val exported = (share.prepare(FIRST) as LibraryResult.Success).value
    assertEquals(
      setOf("private_host", "credential_header", "credential_query"),
      exported.warnings.map { it.code }.toSet(),
    )
    val bundle =
      (PrototypeBundleReader.read(files.files.getValue(exported.name))
          as PrototypeBundleReadResult.Success)
        .bundle
    assertEquals(raw, bundle.spec.toString(Charsets.UTF_8))
  }

  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      Fixtures.spec
      ImportBundleFixtures.minimal
    }
  }
}
