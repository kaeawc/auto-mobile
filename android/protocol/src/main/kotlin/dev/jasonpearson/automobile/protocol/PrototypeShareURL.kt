package dev.jasonpearson.automobile.protocol

internal object PrototypeShareURL {
  fun validURL(value: String, dynamic: Boolean = false): Boolean {
    val start =
      when {
        value.startsWith("https://", true) -> 8
        value.startsWith("http://", true) -> 7
        else -> return false
      }
    if (value.any { it.code <= 32 || it.code == 127 || it == '\\' }) return false
    val candidate = if (dynamic) PrototypeShareValues.maskTemplate(value, "1") else value
    val authority = candidate.substring(start).takeWhile { it !in "/?#" }
    if (authority.isEmpty() || authority.any { it in "{}<>^|%@" }) return false
    return if (authority.startsWith("[")) validIPv6(authority) else validHost(authority)
  }

  private fun validPort(port: String?): Boolean {
    if (port.isNullOrEmpty()) return true
    return port.length in 1..5 && port.all { it in '0'..'9' } && port.toInt() <= 65535
  }

  private fun validHost(authority: String): Boolean {
    val parts = authority.split(':')
    if (parts.size > 2 || parts[0].isEmpty() || parts[0].any { it in "[]" }) return false
    return validPort(parts.getOrNull(1))
  }

  private fun validIPv6(authority: String): Boolean {
    val end = authority.indexOf(']')
    if (end < 0) return false
    if (!validAddress(authority.substring(1, end))) return false
    val tail = authority.substring(end + 1)
    if (tail.isNotEmpty() && !tail.startsWith(":")) return false
    return validPort(if (tail.isEmpty()) null else tail.substring(1))
  }

  private fun validAddress(address: String): Boolean {
    val halves = address.split("::")
    val groups = halves.flatMap { if (it.isEmpty()) emptyList() else it.split(':') }
    if (halves.size > 2 || groups.any { !validGroup(it) }) return false
    return if (halves.size == 1) groups.size == 8 else groups.size < 8
  }

  private fun validGroup(group: String): Boolean =
    group.length in 1..4 && group.all { it in "0123456789abcdefABCDEF" }
}
