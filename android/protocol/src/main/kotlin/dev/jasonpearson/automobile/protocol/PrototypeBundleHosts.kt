package dev.jasonpearson.automobile.protocol

/** Literal-only address classification. Never invokes InetAddress or a resolver. */
internal object PrototypeBundleHosts {
  fun isPrivate(host: String): Boolean {
    if (':' !in host) return ipv4(host.removeSuffix("."))?.let(::privateV4) ?: false
    val words = ipv6(host) ?: return false
    if (words.take(3) == listOf(0x64, 0xff9b, 1)) {
      val bytes = words.flatMap { listOf(it shr 8, it and 255) }
      return listOf(
          listOf(6, 7, 9, 10),
          listOf(7, 9, 10, 11),
          listOf(9, 10, 11, 12),
          listOf(12, 13, 14, 15),
        )
        .any { layout -> privateV4(layout.fold(0L) { n, i -> n * 256 + bytes[i] }) }
    }
    val prefixes =
      listOf(
        listOf(0, 0, 0, 0, 0, 0),
        listOf(0, 0, 0, 0, 0, 65535),
        listOf(0, 0, 0, 0, 65535, 0),
        listOf(0x64, 0xff9b, 0, 0, 0, 0),
      )
    val pair =
      when {
        words[0] == 0x2002 -> words.subList(1, 3)
        prefixes.any { words.take(6) == it } -> words.takeLast(2)
        else -> null
      }
    if (pair != null) return privateV4(pair[0].toLong() * 65536 + pair[1])
    return privateV6(words)
  }

  private fun privateV6(words: List<Int>): Boolean {
    return words.take(2) == listOf(0x2001, 0) ||
      words[0] and 0xffc0 in setOf(0xfe80, 0xfec0) ||
      words[0] and 0xff00 == 0xff00 ||
      words[0] and 0xfe00 == 0xfc00 ||
      (words[0] == 0x3fff && words[1] and 0xf000 == 0) ||
      listOf(listOf(0x100, 0, 0, 0), listOf(0x2001, 2, 0), listOf(0x2001, 0xdb8), listOf(0x5f00))
        .any { words.take(it.size) == it }
  }

  private fun privateV4(n: Long): Boolean =
    listOf(
        0x00000000L..0x00ffffffL,
        0x7f000000L..0x7fffffffL,
        0xa9fe0000L..0xa9feffffL,
        0xe0000000L..0xffffffffL,
        0x0a000000L..0x0affffffL,
        0xac100000L..0xac1fffffL,
        0xc0a80000L..0xc0a8ffffL,
        0x64400000L..0x647fffffL,
        0xc0000000L..0xc00000ffL,
        0xc0000200L..0xc00002ffL,
        0xc6336400L..0xc63364ffL,
        0xcb007100L..0xcb0071ffL,
        0xc6120000L..0xc613ffffL,
      )
      .any { n in it }

  private fun ipv4(host: String): Long? {
    val parts = host.split('.')
    if (parts.size !in 1..4) return null
    val values = parts.map { part ->
      val (digits, radix) =
        when {
          part.startsWith("0x", true) -> part.drop(2) to 16
          part.length > 1 && part.startsWith('0') -> part.drop(1) to 8
          else -> part to 10
        }
      if (digits.isEmpty() || digits.any { it.lowercaseChar() !in "0123456789abcdef".take(radix) })
        return null
      digits.toLongOrNull(radix)?.takeIf { it <= 0xffffffffL } ?: return null
    }
    if (values.dropLast(1).any { it > 255 } || values.last() >= 1L.shl(8 * (5 - values.size)))
      return null
    return values.dropLast(1).foldIndexed(values.last()) { index, n, part ->
      n or (part shl (24 - index * 8))
    }
  }

  private fun groups(s: String): List<Int>? {
    if (s.isEmpty()) return emptyList()
    val result = mutableListOf<Int>()
    for (token in s.split(':')) {
      if ('.' in token) {
        val n = ipv4(token) ?: return null
        result.add((n shr 16).toInt())
        result.add((n and 65535).toInt())
      } else {
        if (token.length !in 1..4 || token.any { it.lowercaseChar() !in "0123456789abcdef" })
          return null
        result.add(token.toInt(16))
      }
    }
    return result
  }

  private fun ipv6(host: String): List<Int>? {
    val halves = host.split("::")
    if (halves.size > 2 || '%' in host) return null
    val head = groups(halves[0]) ?: return null
    val tail = if (halves.size == 2) groups(halves[1]) ?: return null else emptyList()
    val missing = 8 - head.size - tail.size
    if (missing < 0) return null
    if (halves.size == 1 && missing != 0) return null
    if (halves.size == 2 && missing == 0) return null
    return head + List(missing) { 0 } + tail
  }
}
