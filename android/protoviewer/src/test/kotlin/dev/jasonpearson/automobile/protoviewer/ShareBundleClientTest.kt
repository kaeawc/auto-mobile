package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.protocol.PrototypeBundleLimits
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.InetAddress
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class ShareBundleClientTest {
  private val publicAddress =
    InetAddress.getByAddress(byteArrayOf(93, 184.toByte(), 216.toByte(), 34))
  private val resolved = mutableListOf<String>()
  private var addresses = listOf(publicAddress)
  private val resolver = ShareBundleResolver { host ->
    resolved += host
    addresses
  }
  private val connections = mutableListOf<Pair<HttpUrl, List<InetAddress>>>()
  private val responses = ArrayDeque<FakeResponse>()
  private val connection = ShareBundleConnection { url, snapshot ->
    connections += url to snapshot
    responses.removeFirst()
  }

  @Test
  fun redirectToHttpIsRejectedWithoutAnotherLookupOrConnection() {
    val redirect = FakeResponse(302, "http://other.example/file")
    responses += redirect
    assertFailure(ShareImportError.Blocked) { client().download(URL) }
    assertEquals(listOf("bundles.example"), resolved)
    assertEquals(1, connections.size)
    assertTrue(redirect.closed)
    assertEquals(0, redirect.reads)
  }

  @Test
  fun redirectToPrivateDaemonAddressIsBlockedAfterResolution() {
    responses += FakeResponse(302, "https://private.example:3000/file")
    val changingResolver = ShareBundleResolver { host ->
      resolved += host
      if (host == "private.example")
        listOf(InetAddress.getByAddress(byteArrayOf(192.toByte(), 168.toByte(), 1, 5)))
      else listOf(publicAddress)
    }
    val client = PolicyShareBundleClient(changingResolver, connection)
    assertFailure(ShareImportError.Blocked) { client.download(URL) }
    assertEquals(listOf("bundles.example", "private.example"), resolved)
    assertEquals(1, connections.size)
  }

  @Test
  fun redirectToResolvedLoopbackIsBlocked() {
    responses += FakeResponse(307, "https://internal.example/file")
    val changingResolver = ShareBundleResolver { host ->
      if (host == "internal.example") listOf(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
      else listOf(publicAddress)
    }
    assertFailure(ShareImportError.Blocked) {
      PolicyShareBundleClient(changingResolver, connection).download(URL)
    }
    assertEquals(1, connections.size)
  }

  @Test
  fun everyHopPassesItsCheckedDnsSnapshotToConnection() {
    val redirect = FakeResponse(303, "https://cdn.example/file")
    val body = FakeResponse()
    responses += redirect
    responses += body
    assertArrayEquals(ImportBundleFixtures.minimal, client().download(URL))
    assertEquals(listOf("bundles.example", "cdn.example"), resolved)
    assertEquals(
      listOf(listOf(publicAddress), listOf(publicAddress)),
      connections.map { it.second },
    )
    assertTrue(redirect.closed)
    assertTrue(body.closed)
  }

  @Test
  fun emptyDnsAnswerNeverConnects() {
    addresses = emptyList()
    assertFailure(ShareImportError.Blocked) { client().download(URL) }
    assertTrue(connections.isEmpty())
  }

  @Test
  fun declaredSizeOverExistingBundleLimitIsRejectedWithoutReading() {
    val response = FakeResponse(length = PrototypeBundleLimits.MAX_COMPRESSED_BYTES.toLong() + 1)
    responses += response
    assertFailure(ShareImportError.TooLarge) { client().download(URL) }
    assertEquals(0, response.reads)
    assertTrue(response.closed)
  }

  @Test
  fun unknownOrUnderstatedLengthCannotBypassStreamingCap() {
    for (length in listOf(-1L, 1L)) {
      val response = FakeResponse(length = length)
      responses += response
      // A small injected cap exercises the same loop without allocating a maximum-size bundle.
      assertFailure(ShareImportError.TooLarge) { client(maxBytes = 8).download(URL) }
      assertEquals(9, response.reads)
      assertTrue(response.closed)
    }
  }

  @Test
  fun exactlyAtCapSucceeds() {
    responses += FakeResponse(length = -1)
    assertArrayEquals(
      ImportBundleFixtures.minimal,
      client(maxBytes = ImportBundleFixtures.minimal.size).download(URL),
    )
  }

  @Test
  fun redirectCredentialsAndFragmentsAreRejected() {
    for (location in listOf("https://user@cdn.example/a", "https://cdn.example/a#fragment")) {
      responses += FakeResponse(302, location)
      assertFailure(ShareImportError.Blocked) { client().download(URL) }
    }
    assertEquals(2, connections.size)
  }

  @Test
  fun missingLocationAndRedirectLoopFailAndCloseResponses() {
    val missing = FakeResponse(302)
    responses += missing
    assertFailure(ShareImportError.Download) { client().download(URL) }
    assertTrue(missing.closed)
    val loop = List(6) { FakeResponse(302, "/again") }
    responses.addAll(loop)
    assertFailure(ShareImportError.Download) { client().download(URL) }
    assertTrue(loop.all { it.closed })
  }

  private fun client(maxBytes: Int = PrototypeBundleLimits.MAX_COMPRESSED_BYTES) =
    PolicyShareBundleClient(resolver, connection, maxBytes = maxBytes)

  private fun assertFailure(expected: ShareImportError, action: () -> Unit) {
    val failure = assertThrows(ShareImportException::class.java, action)
    assertEquals(expected, failure.error)
  }

  private class FakeResponse(
    override val code: Int = 200,
    override val location: String? = null,
    override val length: Long = ImportBundleFixtures.minimal.size.toLong(),
  ) : ShareBundleResponse {
    var closed = false
    var reads = 0
    override val body: InputStream =
      object : ByteArrayInputStream(ImportBundleFixtures.minimal) {
        override fun read(bytes: ByteArray, offset: Int, count: Int): Int =
          super.read(bytes, offset, count).also { if (it > 0) reads += it }
      }

    override fun close() {
      closed = true
      body.close()
    }
  }

  private companion object {
    val URL = "https://bundles.example/demo.automobile-proto".toHttpUrl()
  }
}
