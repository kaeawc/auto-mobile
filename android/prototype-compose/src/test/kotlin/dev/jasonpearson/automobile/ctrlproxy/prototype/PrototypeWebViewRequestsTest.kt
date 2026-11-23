package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.io.ByteArrayInputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PrototypeWebViewRequestsTest {
  private val first = "https://example.com/start"
  private val second = "https://example.org/end"
  private val origins = listOf("https://example.com", "https://example.org")

  @Test
  fun followsAllowedSubresourceRedirectAndReissuesMainFrameRedirect() {
    val visited = mutableListOf<String>()
    val requests =
      PrototypeWebViewRequests(
        origins,
        PrototypeWebFetcher { url, _, _ ->
          visited += url
          if (url == first) PrototypeWebFetchResult(302, "Found", redirectLocation = second)
          else PrototypeWebFetchResult(200, "OK", body = ByteArrayInputStream(byteArrayOf(42)))
        },
      )

    val subresource = requests.serve(first, "GET", emptyMap(), false)
    assertEquals(listOf(first, second), visited)
    assertEquals(42, subresource.response.body.read())

    visited.clear()
    val mainFrame = requests.serve(first, "GET", emptyMap(), true)
    assertEquals(listOf(first), visited)
    assertEquals(204, mainFrame.response.status)
    assertEquals(second, mainFrame.redirectUrl)
    assertEquals(
      200,
      requests.serve(second, "GET", emptyMap(), true, mainFrame.redirectHops).response.status,
    )
  }

  @Test
  fun blocksRedirectBeforeAnyRequestToItsDestination() {
    for (target in listOf("https://evil.com/end", "http://example.com/end")) {
      for (mainFrame in listOf(false, true)) {
        val requests =
          PrototypeWebViewRequests(
            origins,
            PrototypeWebFetcher { url, _, _ ->
              assertEquals(first, url)
              PrototypeWebFetchResult(302, "Found", redirectLocation = target)
            },
          )
        val result = requests.serve(first, "GET", emptyMap(), mainFrame)
        assertEquals(403, result.response.status)
        assertEquals(-1, result.response.body.read())
        assertEquals(if (mainFrame) target else null, result.blockedUrl)
      }
    }
  }

  @Test
  fun rejectsLongChainsInEitherFrame() {
    var calls = 0
    val requests =
      PrototypeWebViewRequests(
        origins,
        PrototypeWebFetcher { _, _, _ ->
          calls++
          PrototypeWebFetchResult(302, "Found", redirectLocation = "/next")
        },
      )
    assertEquals(502, requests.serve(first, "GET", emptyMap(), false).response.status)
    assertEquals(6, calls)
    var result = requests.serve(first, "GET", emptyMap(), true)
    repeat(5) {
      result =
        requests.serve(
          checkNotNull(result.redirectUrl),
          "GET",
          emptyMap(),
          true,
          result.redirectHops,
        )
    }
    assertEquals(502, result.response.status)
    assertNull(result.redirectUrl)
    assertEquals(12, calls)
  }

  @Test
  fun permitsOnlyGetAndHeadAndStripsCredentialHeaders() {
    val requests =
      PrototypeWebViewRequests(
        origins,
        PrototypeWebFetcher { _, method, headers ->
          assertEquals("HEAD", method)
          assertEquals(mapOf("Accept" to "*/*", "User-Agent" to "test"), headers)
          PrototypeWebFetchResult(200, "OK")
        },
      )
    val headers =
      mapOf(
        "Accept" to "*/*",
        "User-Agent" to "test",
        "cookie" to "secret",
        "AUTHORIZATION" to "secret",
        "Referer" to first,
      )
    assertEquals(405, requests.serve(first, "POST", headers, true).response.status)
    assertEquals(200, requests.serve(first, "HEAD", headers, true).response.status)
  }

  @Test
  fun reportsResolvedAddressBlockForMainFrameOnly() {
    val requests =
      PrototypeWebViewRequests(
        origins,
        PrototypeWebFetcher { _, _, _ ->
          PrototypeWebFetchResult(403, "Forbidden", destinationBlocked = true)
        },
      )
    val main = requests.serve(first, "GET", emptyMap(), true)
    assertEquals(403, main.response.status)
    assertEquals(first, main.blockedUrl)
    assertNull(requests.serve(first, "GET", emptyMap(), false).blockedUrl)
  }
}
