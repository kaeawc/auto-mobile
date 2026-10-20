package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.io.IOException
import java.net.InetAddress
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.Response

sealed interface PrototypeEgressDecision {
  data object Allow : PrototypeEgressDecision

  data class Blocked(val reason: String) : PrototypeEgressDecision
}

/** A pure destination check; tests may explicitly supply a permissive implementation. */
fun interface PrototypeDestinationPolicy {
  fun check(host: String, port: Int, resolvedAddresses: List<InetAddress>): PrototypeEgressDecision
}

class PrototypeBlockedDestinationException(override val message: String) : IOException(message)

internal fun PrototypeEgressDecision.requireAllowed() {
  if (this is PrototypeEgressDecision.Blocked) throw PrototypeBlockedDestinationException(reason)
}

/** Device-side egress policy. Address parsing never performs a DNS lookup. */
class PrototypeEgressPolicy(
  private val daemonPorts: Set<Int> = (3000..3010).toSet() + 8765,
) : PrototypeDestinationPolicy {
  override fun check(
    host: String,
    port: Int,
    resolvedAddresses: List<InetAddress>,
  ): PrototypeEgressDecision {
    val name = host.removeSurrounding("[", "]").trimEnd('.').lowercase()
    if (name == "localhost" || name.endsWith(".localhost")) {
      return PrototypeEgressDecision.Blocked("Blocked destination hostname")
    }
    val literal = literalBytes(name)
    if (literal == null && numericHost(name)) {
      return PrototypeEgressDecision.Blocked("Ambiguous numeric destination")
    }
    val addresses = resolvedAddresses.map { it.address } + listOfNotNull(literal)
    if (addresses.any { blockedAddress(it) }) {
      return PrototypeEgressDecision.Blocked("Blocked destination address")
    }
    if (port in daemonPorts && addresses.any { privateAddress(it) }) {
      return PrototypeEgressDecision.Blocked("Blocked destination port on a non-public address")
    }
    return PrototypeEgressDecision.Allow
  }

  private fun blockedAddress(bytes: ByteArray): Boolean {
    val b = bytes.map { it.toInt() and 0xff }
    if (b.size == 4) {
      return b[0] in setOf(0, 127) ||
        (b[0] == 169 && b[1] == 254) ||
        (b.take(3) == listOf(10, 0, 2) && b[3] in 1..6) ||
        b == listOf(10, 0, 3, 2)
    }
    return b.all { it == 0 } ||
      (b.take(15).all { it == 0 } && b[15] == 1) ||
      (b[0] == 0xfe && b[1] and 0xc0 in setOf(0x80, 0xc0)) ||
      (b.take(4) == listOf(0x20, 0x01, 0, 0)) ||
      (embeddedIpv4(bytes)?.let { blockedAddress(it) } == true)
  }

  private fun privateAddress(bytes: ByteArray): Boolean {
    val b = bytes.map { it.toInt() and 0xff }
    if (b.size == 4) {
      return b[0] == 10 ||
        (b[0] == 172 && b[1] in 16..31) ||
        (b[0] == 192 && b[1] == 168) ||
        (b[0] == 100 && b[1] in 64..127)
    }
    return b[0] and 0xfe == 0xfc || (embeddedIpv4(bytes)?.let { privateAddress(it) } == true)
  }

  private fun embeddedIpv4(bytes: ByteArray): ByteArray? {
    val b = bytes.map { it.toInt() and 0xff }
    return when {
      b.take(12).all { it == 0 } -> bytes.copyOfRange(12, 16)
      b.take(10).all { it == 0 } && b[10] == 255 && b[11] == 255 -> bytes.copyOfRange(12, 16)
      b.take(8).all { it == 0 } && b.slice(8..11) == listOf(255, 255, 0, 0) ->
        bytes.copyOfRange(12, 16)
      b.take(12) == listOf(0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0) -> bytes.copyOfRange(12, 16)
      b.take(6) == listOf(0, 0x64, 0xff, 0x9b, 0, 1) ->
        // Support the zero subnet's /96 layout as well as RFC 6052's /48 layout, which skips
        // the reserved octet at byte 8. Both feed the same IPv4 and daemon-port checks.
        if (b.slice(6..11).all { it == 0 }) bytes.copyOfRange(12, 16)
        else byteArrayOf(bytes[6], bytes[7], bytes[9], bytes[10])
      b[0] == 0x20 && b[1] == 0x02 -> bytes.copyOfRange(2, 6)
      else -> null
    }
  }

  internal companion object {
    /** Canonicalize legacy IPv4 before OkHttp can hand the host to a resolver. */
    fun normalize(url: HttpUrl): HttpUrl {
      val bytes = literalBytes(url.host.trimEnd('.')) ?: return url
      if (bytes.size != 4) return url
      return url
        .newBuilder()
        .host(bytes.joinToString(".") { (it.toInt() and 0xff).toString() })
        .build()
    }

    private fun numericHost(host: String): Boolean {
      val last = host.substringAfterLast('.').trimStart('+', '-')
      return ':' in host || last.all { it in '0'..'9' } || last.startsWith("0x", true)
    }

    private fun literalBytes(host: String): ByteArray? =
      if (':' in host) ipv6Bytes(host) else ipv4Bytes(host)

    /** inet_aton forms: one to four decimal, octal or hex components, with checked widths. */
    private fun ipv4Bytes(host: String): ByteArray? {
      val parts = host.split('.')
      if (parts.size !in 1..4) return null
      val values = parts.map { component(it) ?: return null }
      if (values.dropLast(1).any { it > 255 }) return null
      val remainingBits = 8 * (5 - parts.size)
      if (values.last() >= (1L shl remainingBits)) return null
      var address = values.last()
      values.dropLast(1).forEachIndexed { index, value ->
        address = address or (value shl (24 - index * 8))
      }
      return ByteArray(4) { (address shr (24 - it * 8)).toByte() }
    }

    private fun component(part: String): Long? {
      val (digits, radix) =
        when {
          part.startsWith("0x", true) -> part.drop(2) to 16
          part.length > 1 && part.startsWith('0') -> part.drop(1) to 8
          else -> part to 10
        }
      val alphabet = "0123456789abcdef".take(radix)
      if (digits.isEmpty() || digits.any { it.lowercaseChar() !in alphabet }) return null
      return digits.toLongOrNull(radix)?.takeIf { it <= 0xffff_ffffL }
    }

    private fun ipv6Bytes(host: String): ByteArray? {
      // HttpUrl's strict IPv6 parser is available on every supported Android API and does no I/O.
      val canonical =
        runCatching { HttpUrl.Builder().scheme("http").host(host).build().host }.getOrNull()
          ?: return null
      if (':' !in canonical) return ipv4Bytes(canonical)
      val halves = canonical.split("::", limit = 2)
      fun groups(value: String) = if (value.isEmpty()) emptyList() else value.split(':')
      val left = groups(halves[0])
      val right = if (halves.size == 2) groups(halves[1]) else emptyList()
      val words = left + List(8 - left.size - right.size) { "0" } + right
      return ByteArray(16) { index ->
        val word = words[index / 2].toInt(16)
        (if (index % 2 == 0) word shr 8 else word).toByte()
      }
    }
  }
}

/** Returns precisely the delegate's validated snapshot, never resolving a second time. */
class PrototypePolicyDns(
  private val delegate: Dns,
  private val policy: PrototypeDestinationPolicy,
  private val port: Int,
) : Dns {
  override fun lookup(hostname: String): List<InetAddress> {
    policy.check(hostname, port, emptyList()).requireAllowed()
    val addresses = delegate.lookup(hostname).toList()
    if (addresses.isEmpty()) throw PrototypeBlockedDestinationException("No destination addresses")
    policy.check(hostname, port, addresses).requireAllowed()
    return addresses
  }
}

/** Checks the actual socket as well, including pooled connections and IP literals. */
class PrototypeEgressInterceptor(private val policy: PrototypeDestinationPolicy) : Interceptor {
  override fun intercept(chain: Interceptor.Chain): Response {
    val url = chain.request().url
    val socket = chain.connection()?.route()?.socketAddress
    val address =
      socket?.address ?: throw PrototypeBlockedDestinationException("Unresolved destination socket")
    policy.check(url.host, url.port, listOf(address)).requireAllowed()
    policy.check(url.host, socket.port, listOf(address)).requireAllowed()
    return chain.proceed(chain.request())
  }
}
