package dev.jasonpearson.automobile.protocol

import kotlin.test.*
import org.junit.jupiter.api.Test

class PrototypeBundleSecretsTest {
  @Test
  fun `warnings expose paths only and preserve TS stack traversal order`() {
    val spec =
      """{"first":{"type":"request","url":"https://public.example/?token=never-copy&key=never-copy","headers":{"Authorization":"never-copy","X-Api-Key":"never-copy"}},"last":{"type":"request","url":"http://127.1/?sig=never-copy","headers":{"Cookie":"never-copy"}}}"""
    assertEquals(
      listOf(
        PrototypeBundleSecretWarning("credential_header", "$.last.headers.Cookie"),
        PrototypeBundleSecretWarning("credential_query", "$.last.url.query.sig"),
        PrototypeBundleSecretWarning("private_host", "$.last.url"),
        PrototypeBundleSecretWarning("credential_header", "$.first.headers.Authorization"),
        PrototypeBundleSecretWarning("credential_header", "$.first.headers.X-Api-Key"),
        PrototypeBundleSecretWarning("credential_query", "$.first.url.query.token"),
        PrototypeBundleSecretWarning("credential_query", "$.first.url.query.key"),
      ),
      PrototypeBundleSecrets.scan(spec.toByteArray()),
    )
  }

  @Test
  fun `literal local and private hosts warn without DNS`() {
    for (host in
      listOf(
        "localhost.",
        "sub.localhost",
        "10.0.2.2",
        "192.168.0.1",
        "0x7f000001",
        "[::1]",
        "[::ffff:127.0.0.1]",
        "[fc00::1]",
        "[2001:db8::1]",
      )) {
      assertEquals(
        listOf(PrototypeBundleSecretWarning("private_host", "$.url")),
        PrototypeBundleSecrets.scan("""{"type":"request","url":"https://$host/"}""".toByteArray()),
        host,
      )
    }
  }

  @Test
  fun `public URLs do not warn and invalid JSON is advisory`() {
    for (value in
      listOf(
        """{"type":"request","url":"https://example.com/path?q=ok"}""",
        """{"type":"request","url":"https://8.8.8.8/"}""",
        """{"type":"request","url":"https://[2606:4700:4700::1111]/"}""",
        "{}",
        "{",
        """{"a":1,"a":2}""",
      )) assertTrue(PrototypeBundleSecrets.scan(value.toByteArray()).isEmpty(), value)
  }

  @Test
  fun `query names are decoded and warnings are not raw text matches`() {
    assertEquals(
      listOf(PrototypeBundleSecretWarning("credential_query", "$.url.query.Token")),
      PrototypeBundleSecrets.scan(
        """{"type":"request","url":"https://example.com/?%54oken=value","headers":{"Accept":"Authorization"}}"""
          .toByteArray(),
      ),
    )
    assertTrue(
      PrototypeBundleSecrets.scan("""{"text":"token=secret http://localhost"}""".toByteArray())
        .isEmpty(),
    )
  }
}
