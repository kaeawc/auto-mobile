package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeWebViewPolicyTest {
  private val origins = listOf("https://example.com", "https://example.com:8443")

  @Test
  fun acceptsExactOriginsWithNormalizedHostAndPort() {
    for (url in
      listOf("https://example.com", "https://EXAMPLE.com:443/x", "https://example.com:8443")) {
      assertEquals(
        url,
        PrototypeWebViewPolicy.Allow,
        PrototypeWebViewPolicy.check(url, origins, true),
      )
    }
  }

  @Test
  fun refusesEveryOtherOriginInEitherFrame() {
    val urls =
      listOf(
        "https://other.com",
        "https://example.com.evil.com",
        "https://evilexample.com",
        "https://sub.example.com",
        "https://example.com:444",
        "https://example.com:3000",
        "https://example.com:8765",
        "http://example.com",
        "javascript:void(0)",
        "file:///tmp/page",
        "content://example.com/page",
        "data:text/plain,test",
        "intent://example.com",
        "about:blank",
        "blob:https://example.com/id",
        "https://user@example.com",
        "https:///page",
      )
    for (url in urls) {
      for (mainFrame in listOf(false, true)) {
        assertTrue(
          url,
          PrototypeWebViewPolicy.check(url, origins, mainFrame) is PrototypeWebViewPolicy.Block,
        )
      }
    }
  }

  @Test
  fun refusesPrivateHostsAndDaemonPortsEvenWhenListed() {
    for (host in
      listOf(
        "localhost",
        "foo.localhost",
        "localhost.",
        "127.0.0.1",
        "10.0.2.2",
        "169.254.169.254",
        "[::1]",
        "0x7f.1",
        "2130706433",
        "example.com:3000",
        "example.com:8765",
      )) {
      val url = "https://$host"
      assertTrue(
        url,
        PrototypeWebViewPolicy.check(url, listOf(url), true) is PrototypeWebViewPolicy.Block,
      )
    }
    val custom = "https://example.com:9999"
    assertTrue(
      PrototypeWebViewPolicy.check(custom, listOf(custom), true, setOf(9999))
        is PrototypeWebViewPolicy.Block,
    )
  }
}
