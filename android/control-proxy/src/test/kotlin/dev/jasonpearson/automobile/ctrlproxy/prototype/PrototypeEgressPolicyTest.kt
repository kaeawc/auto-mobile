package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import okhttp3.Address
import okhttp3.Connection
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.Route
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class PrototypeEgressPolicyTest {
  private val policy = PrototypeEgressPolicy()

  private fun address(vararg bytes: Int): InetAddress =
    InetAddress.getByAddress(bytes.map { it.toByte() }.toByteArray())

  @Test
  fun `blocked literal forms and local hostnames are refused without DNS`() {
    val hosts =
      listOf(
        "127.0.0.1",
        "127.1.2.3",
        "2130706433",
        "0x7f.1",
        "0177.0.0.1",
        "127.1",
        "[::1]",
        "[::]",
        "[::ffff:127.0.0.1]",
        "[::ffff:7f00:1]",
        "[::ffff:a9fe:a9fe]",
        "[::127.0.0.1]",
        "[::7f00:1]",
        "[64:ff9b::7f00:1]",
        "[2002:7f00:1::]",
        "[fe80::1]",
        "[febf::1]",
        "169.254.169.254",
        "0.0.0.0",
        "0.1.2.3",
        "10.0.2.2",
        "10.0.2.3",
        "localhost",
        "LOCALHOST.",
        "foo.localhost",
      )
    hosts.forEach { host ->
      assertTrue(host, policy.check(host, 80, emptyList()) is PrototypeEgressDecision.Blocked)
      val url = "http://$host/".toHttpUrl()
      assertTrue(
        host,
        policy.check(url.host, url.port, emptyList()) is PrototypeEgressDecision.Blocked,
      )
    }
  }

  @Test
  fun `ambiguous numeric destinations are refused`() {
    listOf(
        "09.0.0.1",
        "1.2.3.256",
        "4294967296",
        "0x",
        "1.2.3.4.5",
        "name.123",
        "1..2",
        "+2130706433",
        "-1",
        "-0x7f000001",
      )
      .forEach { host ->
        assertTrue(host, policy.check(host, 80, emptyList()) is PrototypeEgressDecision.Blocked)
      }
  }

  @Test
  fun `public and permitted private destinations remain allowed`() {
    listOf(
        "8.8.8.8",
        "10.0.2.0",
        "10.0.2.7",
        "10.0.3.1",
        "10.0.3.3",
        "10.1.2.3",
        "172.16.1.1",
        "192.168.1.10",
        "192.168.1.1",
        "[2001:4860:4860::8888]",
        "[64:ff9b::808:808]",
        "[2002:808:808::]",
        "[::808:808]",
        "[::ffff:0:808:808]",
        "[64:ff9b:1::808:808]",
        "[64:ff9b:1:808:8:800::]",
        "[2000:ffff::1]",
        "[2001:1::1]",
        "[fe7f::1]",
        "[ff00::1]",
        "example.test",
      )
      .forEach { host ->
        assertEquals(host, PrototypeEgressDecision.Allow, policy.check(host, 80, emptyList()))
      }
  }

  @Test
  fun `additional blocked ranges are checked as literals and DNS answers`() {
    val destinations =
      listOf(
        "fec0::1" to listOf(254, 192, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1),
        "feff:ffff::1" to listOf(254, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1),
        "2001::1" to listOf(32, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1),
        "2001:0:ffff::1" to listOf(32, 1, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1),
        "::ffff:0:7f00:1" to listOf(0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 127, 0, 0, 1),
        "::ffff:0:a9fe:a9fe" to listOf(0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 169, 254, 169, 254),
        "64:ff9b:1::7f00:1" to listOf(0, 100, 255, 155, 0, 1, 0, 0, 0, 0, 0, 0, 127, 0, 0, 1),
        "64:ff9b:1:7f00:0:100::" to listOf(0, 100, 255, 155, 0, 1, 127, 0, 0, 0, 1, 0, 0, 0, 0, 0),
        "64:ff9b:1:a9fe:a9:fe00::" to
          listOf(0, 100, 255, 155, 0, 1, 169, 254, 0, 169, 254, 0, 0, 0, 0, 0),
        "64:ff9b:1:a00:2:400::" to listOf(0, 100, 255, 155, 0, 1, 10, 0, 0, 2, 4, 0, 0, 0, 0, 0),
      ) +
        ((1..6).map { "10.0.2.$it" to listOf(10, 0, 2, it) } + ("10.0.3.2" to listOf(10, 0, 3, 2)))
    destinations.forEach { (host, bytes) ->
      val resolved = address(*bytes.toIntArray())
      assertTrue(host, policy.check(host, 80, emptyList()) is PrototypeEgressDecision.Blocked)
      assertTrue(
        host,
        policy.check(HttpUrl.Builder().scheme("http").host(host).build().host, 80, emptyList())
          is PrototypeEgressDecision.Blocked,
      )
      assertTrue(
        host,
        policy.check("public.test", 80, listOf(resolved)) is PrototypeEgressDecision.Blocked,
      )
    }
  }

  @Test
  fun `legacy public literals are normalized to the exact address checked`() {
    listOf("134744072", "0x8.010.2056", "010.8.8.010", "8.526344").forEach { host ->
      val url = "http://$host:8080/path?q=1".toHttpUrl()
      assertEquals("http://8.8.8.8:8080/path?q=1", PrototypeEgressPolicy.normalize(url).toString())
    }
  }

  @Test
  fun `daemon ports are refused only on private address ranges`() {
    val privateHosts =
      listOf(
        "10.1.2.3",
        "172.16.1.1",
        "192.168.0.1",
        "100.64.0.1",
        "100.127.255.255",
        "[fc00::1]",
        "[fdff::1]",
        "[64:ff9b::a01:203]",
        "[64:ff9b:1::a01:203]",
        "[64:ff9b:1:a01:2:300::]",
        "[::ffff:0:a01:203]",
        "[2002:a01:203::]",
      )
    privateHosts.forEach { host ->
      ((3000..3010).toList() + 8765).forEach { port ->
        assertTrue(
          "$host:$port",
          policy.check(host, port, emptyList()) is PrototypeEgressDecision.Blocked,
        )
      }
      assertEquals(host, PrototypeEgressDecision.Allow, policy.check(host, 3011, emptyList()))
    }
    listOf("8.8.8.8", "100.63.255.255", "100.128.0.0", "172.32.0.1", "[2001:4860::1]").forEach {
      host ->
      assertEquals(host, PrototypeEgressDecision.Allow, policy.check(host, 3000, emptyList()))
    }
    val custom = PrototypeEgressPolicy(setOf(1234))
    assertEquals(PrototypeEgressDecision.Allow, custom.check("10.1.1.1", 3000, emptyList()))
    assertTrue(custom.check("10.1.1.1", 1234, emptyList()) is PrototypeEgressDecision.Blocked)
  }

  @Test
  fun `DNS refuses the entire answer if any address is blocked`() {
    val dns =
      PrototypePolicyDns(Dns { listOf(address(8, 8, 8, 8), address(127, 0, 0, 1)) }, policy, 80)
    assertThrows(PrototypeBlockedDestinationException::class.java) { dns.lookup("public.test") }
    val privateDns = PrototypePolicyDns(Dns { listOf(address(192, 168, 1, 1)) }, policy, 3000)
    assertThrows(PrototypeBlockedDestinationException::class.java) {
      privateDns.lookup("private.test")
    }
  }

  @Test
  fun `DNS returns only the validated snapshot and never resolves twice`() {
    val public = address(8, 8, 8, 8)
    var lookups = 0
    val delegate = Dns { if (lookups++ == 0) listOf(public) else listOf(address(127, 0, 0, 1)) }
    val dns = PrototypePolicyDns(delegate, policy, 80)
    assertEquals(listOf(public), dns.lookup("public.test"))
    assertEquals(1, lookups)
    assertThrows(PrototypeBlockedDestinationException::class.java) { dns.lookup("public.test") }
    assertEquals(2, lookups)
  }

  @Test
  fun `blocked hostnames never reach the DNS delegate and empty answers are refused`() {
    var lookups = 0
    val dns =
      PrototypePolicyDns(
        Dns {
          lookups++
          emptyList()
        },
        policy,
        80,
      )
    assertThrows(PrototypeBlockedDestinationException::class.java) { dns.lookup("LOCALHOST.") }
    assertEquals(0, lookups)
    assertThrows(PrototypeBlockedDestinationException::class.java) { dns.lookup("empty.test") }
  }

  @Test
  fun `resolved IPv6 bytes receive the same checks as literals`() {
    val linkLocal = address(254, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)
    val nat64 = address(0, 100, 255, 155, 0, 0, 0, 0, 0, 0, 0, 0, 127, 0, 0, 1)
    listOf(linkLocal, nat64).forEach {
      assertTrue(policy.check("public.test", 80, listOf(it)) is PrototypeEgressDecision.Blocked)
    }
  }

  @Test
  fun `network interceptor refuses blocked socket addresses before proceeding`() {
    val config = transportConfig
    val destination =
      Address(
        "public.test",
        80,
        config.dns,
        config.socketFactory,
        null,
        null,
        null,
        config.proxyAuthenticator,
        Proxy.NO_PROXY,
        config.protocols,
        config.connectionSpecs,
        config.proxySelector,
      )
    val socketRoute =
      Route(destination, Proxy.NO_PROXY, InetSocketAddress(address(127, 0, 0, 1), 80))
    val connection =
      object : Connection {
        override fun route() = socketRoute

        override fun socket(): java.net.Socket = error("Unused socket")

        override fun handshake(): okhttp3.Handshake? = null

        override fun protocol() = Protocol.HTTP_1_1
      }
    var proceeded = false
    val client =
      config
        .newBuilder()
        .addInterceptor { actual ->
          val chain =
            object : Interceptor.Chain by actual {
              override fun connection() = connection

              override fun proceed(request: Request): Response {
                proceeded = true
                return Response.Builder()
                  .request(request)
                  .protocol(Protocol.HTTP_1_1)
                  .code(200)
                  .message("test")
                  .body("".toResponseBody())
                  .build()
              }
            }
          PrototypeEgressInterceptor(policy).intercept(chain)
        }
        .build()
    val request = Request.Builder().url("http://public.test/").build()
    assertThrows(PrototypeBlockedDestinationException::class.java) {
      client.newCall(request).execute()
    }
    assertTrue(!proceeded)
  }

  private companion object {
    @JvmStatic
    @BeforeClass
    fun initializeLiteralParser() {
      // Initialize OkHttp's literal parsing before timing the table-driven checks.
      "http://[2001:4860::8888]/".toHttpUrl()
      PrototypeEgressPolicy().check("2001:4860::8888", 80, emptyList())
    }

    // Transport initialization belongs to the fixture, outside the timed policy checks.
    val transportConfig = OkHttpClient.Builder().dns(Dns { error("Unexpected DNS lookup") }).build()
  }
}
