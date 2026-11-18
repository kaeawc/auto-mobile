package dev.jasonpearson.automobile.protocol

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import kotlinx.serialization.json.JsonPrimitive

/** Standalone deep-link matching, independent of spec decoding and runtime routing. */
object PrototypeLinkMatcher {
  data class Entry(
    val path: String,
    val query: Map<String, String> = emptyMap(),
    val usedCaptures: Set<String>? = null,
  )

  data class Match(
    val entryIndex: Int,
    val captures: Map<String, String>,
    val query: Map<String, JsonPrimitive>,
  )

  data class TableError(val index: Int, val code: String, val message: String)

  private val nameFormat = Regex("[A-Za-z][A-Za-z0-9_]{0,31}")
  private val literalFormat = Regex("[A-Za-z0-9._~-]+")
  private val typeFormat = Regex("(string|int|number|boolean)\\??")
  private val integerFormat = Regex("-?[0-9]+")
  private val decimalFormat = Regex("[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
  private const val MAX_SAFE_INTEGER = 9007199254740991.0

  private fun captureName(segment: String): String? =
    segment
      .takeIf { it.startsWith("{") && it.endsWith("}") }
      ?.drop(1)
      ?.dropLast(1)
      ?.takeIf { nameFormat.matches(it) }

  private fun patternSegments(path: String): List<String>? {
    if (path == "/") return emptyList()
    if (!path.startsWith("/")) return null
    return path.drop(1).split('/').takeIf { parts ->
      parts.all { literalFormat.matches(it) || captureName(it) != null }
    }
  }

  private fun queryValid(entry: Entry, captures: Set<String>): Boolean =
    entry.query.all { (name, type) ->
      nameFormat.matches(name) && name !in captures && typeFormat.matches(type)
    }

  private fun entryErrors(entry: Entry, index: Int): List<TableError> {
    val segments =
      patternSegments(entry.path)
        ?: return listOf(TableError(index, "badPattern", "Invalid link path pattern"))
    val errors = mutableListOf<TableError>()
    val captures = mutableSetOf<String>()
    for (segment in segments) {
      val name = captureName(segment) ?: continue
      if (!captures.add(name)) {
        errors.add(TableError(index, "duplicateCapture", "Duplicate capture: $name"))
      }
      if (entry.usedCaptures != null && name !in entry.usedCaptures) {
        errors.add(TableError(index, "unusedCapture", "Unused capture: $name"))
      }
    }
    for ((name, type) in entry.query.toSortedMap()) {
      if (!nameFormat.matches(name) || name in captures || !typeFormat.matches(type)) {
        errors.add(TableError(index, "badQuery", "Invalid query declaration: $name"))
      }
    }
    return errors
  }

  /** All errors in entry order; the table limit is reported once at index 32. */
  fun validateLinkTable(entries: List<Entry>): List<TableError> {
    val errors = mutableListOf<TableError>()
    val shapes = mutableSetOf<String>()
    entries.forEachIndexed { index, entry ->
      if (index == 32) {
        errors.add(TableError(index, "tooManyEntries", "At most 32 link entries are allowed"))
      }
      errors.addAll(entryErrors(entry, index))
      val segments = patternSegments(entry.path) ?: return@forEachIndexed
      val shape = segments.joinToString("/") { if (captureName(it) == null) it else "{}" }
      if (!shapes.add(shape)) {
        errors.add(TableError(index, "duplicatePattern", "Duplicate link pattern shape"))
      }
    }
    return errors
  }

  private fun decode(text: String, plus: Boolean): String? {
    val source = text.toByteArray(Charsets.UTF_8)
    val bytes = ArrayList<Byte>()
    var at = 0
    while (at < source.size) {
      val byte = source[at].toInt() and 255
      if (byte == 37) {
        if (at + 2 >= source.size) return null
        val high = source[at + 1].toInt().toChar().digitToIntOrNull(16) ?: return null
        val low = source[at + 2].toInt().toChar().digitToIntOrNull(16) ?: return null
        bytes.add((high * 16 + low).toByte())
        at += 3
      } else {
        bytes.add((if (plus && byte == 43) 32 else byte).toByte())
        at++
      }
    }
    return try {
      Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes.toByteArray()))
        .toString()
    } catch (_: CharacterCodingException) {
      // Malformed external URL bytes are an expected non-match.
      null
    }
  }

  private data class Parts(val segments: List<String>, val query: Map<String, String>)

  private fun urlParts(url: String): Parts? {
    val clean = url.substringBefore('#')
    val separator = clean.indexOf("://")
    if (separator <= 0) return null
    val scheme = clean.substring(0, separator).lowercase(java.util.Locale.ROOT)
    if (!Regex("[a-z][a-z0-9+.-]*").matches(scheme)) return null
    val rest = clean.substring(separator + 3)
    val rawPath = rest.substringBefore('?')
    var path =
      if (scheme == "http" || scheme == "https") {
        val slash = rawPath.indexOf('/')
        if (slash < 0) "" else rawPath.substring(slash)
      } else customSchemePath(rawPath) ?: return null
    path = path.removePrefix("/").removeSuffix("/")
    val segments = if (path.isEmpty()) emptyList() else path.split('/')
    if (segments.any { it.isEmpty() } || rawPath.endsWith("//")) return null
    val decoded = segments.map { decode(it, false)?.takeIf(String::isNotEmpty) ?: return null }
    return Parts(decoded, queryPairs(rest.substringAfter('?', "")))
  }

  private fun queryPairs(text: String): Map<String, String> {
    val pairs = mutableMapOf<String, String>()
    for (pair in text.split('&')) {
      if (pair.isEmpty()) continue
      val key = decode(pair.substringBefore('='), true) ?: continue
      val value = decode(pair.substringAfter('=', ""), true) ?: continue
      if (key !in pairs) pairs[key] = value
    }
    return pairs
  }

  private fun queryValue(value: String, type: String): JsonPrimitive? =
    when (type) {
      "string" -> JsonPrimitive(value)
      "boolean" -> value.toBooleanStrictOrNull()?.let { JsonPrimitive(it) }
      "int" ->
        value
          .takeIf { integerFormat.matches(it) }
          ?.toDoubleOrNull()
          ?.takeIf { it.isFinite() && kotlin.math.abs(it) <= MAX_SAFE_INTEGER }
          ?.let { JsonPrimitive(it) }
      "number" ->
        value
          .takeIf { decimalFormat.matches(it) }
          ?.toDoubleOrNull()
          ?.takeIf { it.isFinite() }
          ?.let { JsonPrimitive(it) }
      else -> null
    }

  private fun matchEntry(entry: Entry, parts: Parts, index: Int): Match? {
    val pattern = patternSegments(entry.path) ?: return null
    if (pattern.size != parts.segments.size) return null
    val captures = mutableMapOf<String, String>()
    for ((at, segment) in pattern.withIndex()) {
      val name = captureName(segment)
      if (name == null) {
        if (segment != parts.segments[at]) return null
      } else {
        if (name in captures) return null
        captures[name] = parts.segments[at]
      }
    }
    if (!queryValid(entry, captures.keys)) return null
    val query = mutableMapOf<String, JsonPrimitive>()
    for ((name, declaration) in entry.query) {
      val value = parts.query[name]
      if (value == null) {
        if (!declaration.endsWith('?')) return null
      } else {
        query[name] = queryValue(value, declaration.removeSuffix("?")) ?: return null
      }
    }
    return Match(index, captures, query)
  }

  /** First matching entry, including query coercion; malformed paths never match. */
  fun match(url: String, entries: List<Entry>): Match? {
    val parts = urlParts(url) ?: return null
    return entries.withIndex().firstNotNullOfOrNull { (index, entry) ->
      matchEntry(entry, parts, index)
    }
  }
}

private fun customSchemePath(rawPath: String): String? {
  val authority = rawPath.substringBefore('/')
  var host = authority.substringAfterLast('@')
  val colon = host.lastIndexOf(':')
  val port = host.substring(colon + 1)
  if (colon >= 0 && port.isNotEmpty() && port.all { it in '0'..'9' }) {
    host = host.substring(0, colon)
  }
  if (authority.isNotEmpty() && host.isEmpty()) return null
  return host + rawPath.substring(authority.length)
}
