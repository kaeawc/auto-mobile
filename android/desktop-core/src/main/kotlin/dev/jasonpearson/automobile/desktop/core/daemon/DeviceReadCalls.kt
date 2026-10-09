package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Whether a device-naming tool call only reads (#10968). Reads never need a session and never take
 * a device: the daemon serves them sessionless, so the desktop sends them with no `sessionUuid` and
 * without allocating the device first. `observe` captures the screen without acting on it, and a
 * `sqlQuery` is a read when [isReadOnlySqlQuery] says its text is.
 *
 * This is a UI hint only. The daemon classifies the call itself and refuses a write from a session
 * that does not hold the device, so a query misjudged here as a read cannot mutate anything.
 */
internal fun isDeviceReadCall(name: String, arguments: JsonObject): Boolean =
  when (name) {
    "observe" -> true
    "sqlQuery" ->
      (arguments["query"] as? JsonPrimitive)
        ?.takeIf { it.isString }
        ?.content
        ?.let(::isReadOnlySqlQuery) == true
    else -> false
  }

/**
 * Mirrors the daemon's `isReadOnlySqlQuery` (`src/server/databaseTools.ts`): one statement that
 * clearly cannot change data. Anything unrecognized counts as a write, so it allocates first.
 */
internal fun isReadOnlySqlQuery(query: String): Boolean {
  if (isMutationQuery(query)) return false
  return !query.trimEnd { it.isWhitespace() || it == ';' }.contains(';')
}

private val READ_ONLY_PRAGMAS =
  setOf(
    "APPLICATION_ID",
    "COMPILE_OPTIONS",
    "DATA_VERSION",
    "DATABASE_LIST",
    "ENCODING",
    "FREELIST_COUNT",
    "PAGE_COUNT",
    "SCHEMA_VERSION",
    "USER_VERSION",
  )

private val MUTATING_KEYWORDS =
  listOf("INSERT", "REPLACE", "UPDATE", "DELETE", "ALTER", "DROP", "CREATE", "TRUNCATE")

private fun isMutationQuery(query: String): Boolean {
  val upper = stripLeadingSqlNoise(query).uppercase()
  return when {
    upper.startsWithKeyword("SELECT") || upper.startsWithKeyword("VALUES") -> false
    upper.startsWithKeyword("PRAGMA") -> !isReadOnlyPragma(upper.removePrefix("PRAGMA"))
    MUTATING_KEYWORDS.any { upper.startsWithKeyword(it) } -> true
    upper.startsWith("WITH") -> findStatementAfterCte(upper).let { it != "SELECT" }
    else -> true
  }
}

private fun isReadOnlyPragma(body: String): Boolean {
  val trimmed = body.trim().trimEnd(';').trim()
  val name = trimmed.substringAfterLast('.').trim()
  val bare = name.isNotEmpty() && name.all { it.isLetterOrDigit() || it == '_' }
  val schemaOk = !trimmed.contains('.') || trimmed.substringBeforeLast('.').trim().isWord()
  return bare && schemaOk && name in READ_ONLY_PRAGMAS
}

private fun String.isWord(): Boolean = isNotEmpty() && all { it.isLetterOrDigit() || it == '_' }

private fun stripLeadingSqlNoise(query: String): String {
  var text = query.trimStart()
  while (true) {
    text =
      when {
        text.startsWith("--") -> text.substringAfter('\n', "")
        text.startsWith("/*") -> text.substringAfter("*/", "")
        else -> return text
      }.trimStart()
  }
}

private fun String.startsWithKeyword(keyword: String): Boolean {
  if (!startsWith(keyword)) return false
  val next = getOrNull(keyword.length)
  return next == null || !(next.isLetterOrDigit() || next == '_')
}

/** The statement keyword after the CTE definitions of [upper], or null when none is found. */
private fun findStatementAfterCte(upper: String): String? {
  var depth = 0
  for (i in 4 until upper.length) {
    when (upper[i]) {
      '(' -> depth++
      ')' -> depth--
      else ->
        if (depth == 0) {
          val remaining = upper.substring(i).trimStart()
          listOf("SELECT", "INSERT", "UPDATE", "DELETE")
            .firstOrNull { remaining.startsWithKeyword(it) }
            ?.let {
              return it
            }
        }
    }
  }
  return null
}
