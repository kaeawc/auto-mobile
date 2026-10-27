package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.protocol.PrototypeBundle
import dev.jasonpearson.automobile.protocol.PrototypeBundleExport
import dev.jasonpearson.automobile.protocol.PrototypeBundleExportInput
import dev.jasonpearson.automobile.protocol.PrototypeBundleLimits
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import java.io.ByteArrayInputStream
import java.io.InputStream
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class LibraryImportTest {
  private var bytes = ImportBundleFixtures.minimal
  private var opens = 0
  private var committed: PrototypeBundle? = null
  private var source: LibrarySource? = null
  private var invalidAsset: String? = null
  private var commitError: LibraryError? = null
  private var stream: InputStream? = null
  private val importer =
    ValidatedLibraryImporter(
      setOf("viewer.exports"),
      ImportContent {
        opens++
        stream ?: ByteArrayInputStream(bytes)
      },
      AutoMobilePrototype.capabilities,
      ImportAssetCheck { invalidAsset },
      LibraryImportCommit { bundle, origin, _ ->
        committed = bundle
        source = origin
        commitError?.let { LibraryResult.Failure(it) } ?: LibraryResult.Success(Fixtures.entry())
      },
    )

  private fun import(
    action: ImportAction? = ImportAction.View,
    uri: String? = "content://external/document",
  ) = importer.import(LibraryImportRequest(action, uri))

  @Test
  fun validBundleSetsFileSource() {
    assertTrue(import() is LibraryImportResult.Imported)
    assertEquals(LibrarySource.file, source)
    assertNotNull(committed)
  }

  @Test
  fun imageAndFontBundleReachesCommitIntact() {
    bytes = ImportBundleFixtures.imageFont
    assertTrue(import() is LibraryImportResult.Imported)
    assertEquals(setOf("image"), committed?.assets?.keys)
    assertEquals(setOf("font"), committed?.fonts?.keys)
  }

  @Test
  fun bareJsonSetsShareSourceFromAction() {
    bytes = SPEC.toByteArray()
    assertTrue(import(ImportAction.Send) is LibraryImportResult.Imported)
    assertEquals(LibrarySource.share, source)
    assertEquals(SPEC, committed?.spec?.toString(Charsets.UTF_8))
  }

  @Test
  fun bareFullscreenWindowChromeModesReachCommit() {
    for (chrome in listOf("none", "bar")) {
      bytes = windowChromeSpec(chrome).toByteArray()
      assertTrue(import() is LibraryImportResult.Imported)
      assertEquals(windowChromeSpec(chrome), committed?.spec?.toString(Charsets.UTF_8))
    }
  }

  @Test
  fun chromelessBundleWithHostCapabilityRequirementReachesCommit() {
    bytes = windowChromeBundle()
    assertTrue(import() is LibraryImportResult.Imported)
    assertEquals(listOf("prototype_window_chrome_v1"), committed?.requires)
    assertEquals(windowChromeSpec("none"), committed?.spec?.toString(Charsets.UTF_8))
  }

  @Test
  fun chromelessBundleRequiresAdvertisedCapabilityBeforeCommit() {
    val old =
      ValidatedLibraryImporter(
        setOf("viewer.exports"),
        ImportContent { ByteArrayInputStream(windowChromeBundle()) },
        AutoMobilePrototype.capabilities - "prototype_window_chrome_v1",
        ImportAssetCheck { null },
        LibraryImportCommit { _, _, _ -> error("Must not commit") },
      )
    assertEquals(
      LibraryImportResult.Rejected("spec.json", UNSUPPORTED_PROTOTYPE_REASON),
      old.import(LibraryImportRequest(ImportAction.View, "content://external/document")),
    )
  }

  private fun windowChromeSpec(chrome: String) =
    """{"id":"chrome","window":{"placement":{"type":"fullscreen"},"chrome":"$chrome"},"root":{"type":"text","text":"Prototype content"}}"""

  @Suppress("INVISIBLE_MEMBER", "INVISIBLE_REFERENCE")
  private fun windowChromeBundle(): ByteArray {
    val spec = windowChromeSpec("none").toByteArray()
    val files =
      PrototypeBundleExport.canonicalFiles(
        PrototypeBundleExportInput(spec, { null }, { null }),
        listOf("prototype_window_chrome_v1"),
      )
    return dev.jasonpearson.automobile.protocol.PrototypeBundleZipWriter.write(files)
  }

  @Test
  fun hostileZipIsRejectedWithPathBeforeCommit() {
    bytes = ImportBundleFixtures.hostile
    val result = import() as LibraryImportResult.Rejected
    assertEquals("../spec.json", result.path)
    assertNull(committed)
  }

  @Test
  fun missingImageRejected() {
    rejectFixture(ImportBundleFixtures.missingImage, "image")
  }

  @Test
  fun missingFontRejected() {
    rejectFixture(ImportBundleFixtures.missingFont, "font")
  }

  @Test
  fun manifestWithoutZipRejected() {
    bytes = ImportBundleFixtures.missingZip
    assertTrue((import() as LibraryImportResult.Rejected).path.startsWith("assets/"))
    assertNull(committed)
  }

  @Test
  fun bareJsonCannotReferenceAbsentAsset() {
    bytes =
      SPEC.replace("\"type\":\"text\"", "\"type\":\"image\",\"asset\":\"missing\"")
        .replace(",\"text\":\"Prototype content\"", "")
        .toByteArray()
    assertEquals("missing", (import() as LibraryImportResult.Rejected).path)
    assertNull(committed)
  }

  @Test
  fun fileUriIsRejectedWithoutOpening() {
    rejectUri("file:///private/spec.json")
  }

  @Test
  fun ownAuthorityIsRejectedWithoutOpening() {
    rejectUri("content://VIEWER.exports/spec")
  }

  @Test
  fun encodedOwnAuthorityIsRejectedWithoutOpening() {
    rejectUri("content://%76iewer.exports/spec")
  }

  @Test
  fun invalidSchemeAndActionRejected() {
    rejectUri("https://external/spec")
    assertTrue(import(null) is LibraryImportResult.Rejected)
    assertTrue(import(uri = null) is LibraryImportResult.Rejected)
    assertTrue(import(uri = "%") is LibraryImportResult.Rejected)
    assertEquals(0, opens)
  }

  @Test
  fun providerNameAndExtensionDoNotDetermineFormat() {
    bytes = SPEC.toByteArray()
    assertTrue(import(uri = "content://external/fake.zip") is LibraryImportResult.Imported)
  }

  @Test
  fun capFailureIsReportedWithoutSuccess() {
    commitError = LibraryError.Limit
    assertEquals(LibraryImportResult.Rejected("library", "Limit"), import())
  }

  @Test
  fun hostRequestRejectedBeforeCommit() {
    bytes =
      """{"id":"host","window":{"placement":{"type":"fullscreen"}},"root":{"type":"button","label":"Load","onTap":[{"type":"request","url":"https://example.com","via":"host"}]}}"""
        .toByteArray()
    assertTrue((import() as LibraryImportResult.Rejected).path.endsWith(".via"))
    assertNull(committed)
  }

  @Test
  fun unsupportedCapabilitiesNeedNewerViewer() {
    val old =
      ValidatedLibraryImporter(
        setOf("viewer.exports"),
        ImportContent {
          ByteArrayInputStream(SPEC.replace("\"root\":", "\"data\":{},\"root\":").toByteArray())
        },
        emptySet(),
        ImportAssetCheck { null },
        LibraryImportCommit { _, _, _ -> error("Must not commit") },
      )
    assertTrue(
      (old.import(LibraryImportRequest(ImportAction.View, "content://external/spec"))
          as LibraryImportResult.Rejected)
        .reason
        .contains("newer ProtoViewer"),
    )
  }

  @Test
  fun pixelFailureNamesAssetAndDoesNotCommit() {
    invalidAsset = "image"
    assertEquals(LibraryImportResult.Rejected("image", "Invalid image dimensions"), import())
    assertNull(committed)
  }

  @Test
  fun jsonStreamStopsAtLimitAndCloses() {
    streamLimit(false)
  }

  @Test
  fun zipStreamStopsAtLimitAndCloses() {
    streamLimit(true)
  }

  @Test
  fun callerCannotSupplySourceThroughSpec() {
    bytes = SPEC.dropLast(1).plus(",\"source\":\"mcp\"}").toByteArray()
    assertTrue(import() is LibraryImportResult.Rejected)
    assertNull(source)
  }

  @Test
  fun duplicateJsonKeyIsRejected() {
    bytes = SPEC.replace("\"id\":\"same-spec-id\"", "\"id\":\"a\",\"id\":\"b\"").toByteArray()
    assertTrue(import() is LibraryImportResult.Rejected)
    assertNull(committed)
  }

  private fun rejectFixture(fixture: ByteArray, path: String) {
    bytes = fixture
    assertEquals(path, (import() as LibraryImportResult.Rejected).path)
    assertNull(committed)
  }

  private fun rejectUri(uri: String) {
    assertTrue(import(uri = uri) is LibraryImportResult.Rejected)
    assertEquals(0, opens)
    assertNull(committed)
  }

  private fun streamLimit(zip: Boolean) {
    val input = CountingStream(zip)
    stream = input
    assertTrue(import() is LibraryImportResult.Rejected)
    val limit =
      if (zip) PrototypeBundleLimits.MAX_COMPRESSED_BYTES else PrototypeBundleLimits.MAX_SPEC_BYTES
    assertEquals(limit + 1, input.count)
    assertTrue(input.closed)
    assertNull(committed)
  }

  private class CountingStream(private val zip: Boolean) : InputStream() {
    var count = 0
    var closed = false

    override fun read(): Int =
      when (count++) {
        0 -> if (zip) 80 else 123
        1 -> if (zip) 75 else 32
        else -> 32
      }

    override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
      bytes.fill(32, offset, offset + length)
      if (count == 0 && length >= 2) {
        bytes[offset] = if (zip) 80 else 123
        bytes[offset + 1] = if (zip) 75 else 32
      }
      count += length
      return length
    }

    override fun close() {
      closed = true
    }
  }

  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      Fixtures.spec
      ImportBundleFixtures.minimal
      AutoMobilePrototype.capabilities
    }
  }
}
