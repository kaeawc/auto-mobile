package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.sha256Hex
import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import java.net.URLEncoder
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

internal fun shareLink(
  url: String = "https://bundles.example/demo.automobile-proto",
  hash: String = "a".repeat(64),
): String = "automobile-proto://import?url=${URLEncoder.encode(url, "UTF-8")}&sha256=$hash"

internal class FakeShareBundleClient : ShareBundleClient {
  val requests = mutableListOf<String>()
  var bytes = ImportBundleFixtures.minimal

  override fun download(url: okhttp3.HttpUrl): ByteArray {
    requests += url.toString()
    return bytes
  }
}

class ShareImportTest {
  @Test
  fun shareLinkValidationTable() {
    val good = shareLink()
    val cases =
      listOf(
        good to true,
        shareLink("https://example.com/a?token=x%26y&download=1") to true,
        shareLink("https://example.com/a b?x=1&y=2") to true,
        shareLink("https://[2001:4860:4860::8888]:8443/a") to true,
        shareLink("http://example.com/a") to false,
        shareLink("https://user:password@example.com/a") to false,
        shareLink("https://user@example.com/a") to false,
        shareLink("https://example.com/a#fragment") to false,
        shareLink("/relative") to false,
        "automobile-proto://import?sha256=${"a".repeat(64)}" to false,
        "automobile-proto://import?url=https%3A%2F%2Fexample.com" to false,
        "$good&extra=1" to false,
        "$good&url=https%3A%2F%2Fother.example" to false,
        "$good&sha256=${"b".repeat(64)}" to false,
        "$good&%75rl=https%3A%2F%2Fother.example" to false,
        "$good&%73ha256=${"b".repeat(64)}" to false,
        shareLink(hash = "a".repeat(63)) to false,
        shareLink(hash = "a".repeat(65)) to false,
        shareLink(hash = "A".repeat(64)) to false,
        shareLink(hash = "g".repeat(64)) to false,
        shareLink("") to false,
        good.replace("//import?", "//other?") to false,
        good.replace("//import?", "//import/path?") to false,
        good.replace("//import?", "//user@import?") to false,
        "$good#fragment" to false,
        "automobile-proto://import?url=%&sha256=${"a".repeat(64)}" to false,
      )
    cases.forEach { (link, expected) ->
      assertEquals(link, expected, ShareImportLink.parse(link) != null)
    }
  }

  @Test
  fun urlRulesMatchHostIncludingEmptyFragmentAndCredentials() {
    // WHATWG URL.hash, username and password are empty in these cases on the host.
    assertNotNull(ShareImportLink.parse(shareLink("https://example.com/a#")))
    assertNotNull(ShareImportLink.parse(shareLink("https://@example.com/a")))
  }

  @Test
  fun hashMismatchNeverCallsStrictReader() {
    val client = FakeShareBundleClient()
    var reads = 0
    val importer =
      VerifiedShareLibraryImporter(
        client,
        LibraryBytesImporter { _, _, _, _ ->
          reads++
          error("Must not read mismatched bytes")
        },
      )
    assertEquals(
      ShareImportResult.Failed(ShareImportError.HashMismatch),
      importer.importConfirmed(checkNotNull(ShareImportLink.parse(shareLink()))),
    )
    assertEquals(1, client.requests.size)
    assertEquals(0, reads)
  }

  @Test
  fun verifiedBundleUsesNormalStrictImportWithShareSource() {
    var source: LibrarySource? = null
    var sourceHost: String? = null
    val strict =
      ValidatedLibraryImporter(
        emptySet(),
        ImportContent { error("Must use downloaded bytes") },
        AutoMobilePrototype.capabilities,
        ImportAssetCheck { null },
        LibraryImportCommit { _, origin, label, host ->
          source = origin
          sourceHost = host
          assertNull(label)
          LibraryResult.Success(Fixtures.entry())
        },
      )
    val client = FakeShareBundleClient()
    val importer = VerifiedShareLibraryImporter(client, strict)
    val link = checkNotNull(ShareImportLink.parse(shareLink(hash = sha256Hex(client.bytes))))
    val result = importer.importConfirmed(link) as ShareImportResult.Completed
    assertTrue(result.result is LibraryImportResult.Imported)
    assertEquals(LibrarySource.share, source)
    assertEquals("bundles.example", sourceHost)
  }

  @Test
  fun matchingHashDoesNotBypassStrictReader() {
    val client = FakeShareBundleClient().apply { bytes = ImportBundleFixtures.hostile }
    val strict =
      ValidatedLibraryImporter(
        emptySet(),
        ImportContent { error("Must use downloaded bytes") },
        AutoMobilePrototype.capabilities,
        ImportAssetCheck { null },
        LibraryImportCommit { _, _, _, _ -> error("Must not commit hostile zip") },
      )
    val link = checkNotNull(ShareImportLink.parse(shareLink(hash = sha256Hex(client.bytes))))
    val result = VerifiedShareLibraryImporter(client, strict).importConfirmed(link)
    assertEquals(
      "../spec.json",
      ((result as ShareImportResult.Completed).result as LibraryImportResult.Rejected).path,
    )
  }

  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      Fixtures.spec
      ImportBundleFixtures.minimal
      AutoMobilePrototype.capabilities
      ShareImportLink.parse(shareLink())
    }
  }
}
