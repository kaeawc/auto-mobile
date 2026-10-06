package dev.jasonpearson.automobile.ctrlproxy

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Source-level guard for #9947: `Regex("\\{(...)}")` compiled on the desktop JVM (so every unit
 * test passed) but threw `PatternSyntaxException` on Android, whose `java.util.regex` is backed by
 * ICU and rejects a lone `}`.
 *
 * What this proves: no regex *literal* in `control-proxy/src/main` or `protocol/src/main` contains
 * a construct from [IcuRegexSyntax.problems] (unescaped `{`/`}`/`]` literals, a `]` opening a
 * character class, `&&` class intersection, lookbehind, named groups, `\h \H \R \X \N`), and no
 * pattern is built from a non-literal or templated string that this scan could not inspect.
 *
 * What this does NOT prove: JVM tests cannot run ICU. The checker is a hand-written approximation
 * of the known JVM-vs-ICU divergences, not ICU itself, so a pattern it accepts could still fail on
 * a device for a divergence it does not model. Loading the overlay classes on a device (or an
 * instrumented test) remains the only complete check.
 */
class IcuRegexCompatibilityTest {

  @Test
  fun `the original 9947 pattern is rejected`() {
    val problems = IcuRegexSyntax.problems("\\{([A-Za-z_][A-Za-z0-9_]*)}")
    assertEquals(1, problems.size)
    assertTrue(problems.single(), problems.single().contains("'}'"))
  }

  @Test
  fun `patterns that use only portable syntax are accepted`() {
    val portable =
      listOf(
        "\\{([A-Za-z_][A-Za-z0-9_]*)\\}",
        "#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?",
        "^[A-Za-z_][A-Za-z0-9_]{0,63}$",
        "x{2,}y{3}",
        "\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]",
        "[{}]+",
        "[^\\]]+",
        "[a-z_]+",
        "\\p{L}+\\Q{}]\\E",
        "\\s",
        "^asset-[0-9]+$",
      )
    portable.forEach { assertEquals(it, emptyList<String>(), IcuRegexSyntax.problems(it)) }
  }

  @Test
  fun `known jvm only constructs are rejected`() {
    val risky =
      mapOf(
        "a{" to "'{'",
        "a{x}" to "'{'",
        "a{,3}" to "'{'",
        "a}" to "'}'",
        "a]" to "']'",
        "[]a]" to "']'",
        "[a-z&&[^aeiou]]" to "'&&'",
        "(?<=a)b" to "lookbehind",
        "(?<year>\\d+)" to "named group",
        "\\h+" to "\\h",
        "a\\R" to "\\R",
        "trailing\\" to "backslash",
      )
    risky.forEach { (pattern, expected) ->
      val problems = IcuRegexSyntax.problems(pattern)
      assertTrue("$pattern -> $problems", problems.any { it.contains(expected) })
    }
  }

  @Test
  fun `every regex literal in control-proxy and protocol main is icu safe`() {
    val sources = mainSourceFiles()
    val found = sources.flatMap { file -> RegexLiteralScanner.scan(file.readText(), file.path) }
    // Scanner-rot guard: if extraction silently stops finding patterns this test would pass
    // vacuously. Rather than an exact count (which breaks whenever a regex is legitimately
    // removed), require the scanner to still see literals in a few files that are known to hold
    // them. If you remove the last regex from one of these files, drop it from this list.
    // WebSocketServer.kt (malformed-frame type scrub, #9935), OverlayAssetDirectory.kt (asset
    // file-name guard) and OverlayRenderModel.kt (colour check) build regexes that landed after the
    // first anchors.
    val anchorFiles =
      listOf(
        "LogcatReader.kt",
        "ElementBounds.kt",
        "OverlaySpecValidator.kt",
        "WebSocketServer.kt",
        "OverlayAssetDirectory.kt",
        "OverlayRenderModel.kt",
      )
    anchorFiles.forEach { name ->
      assertTrue(
        "Scanner found no regex literal in $name (found ${found.size} overall). Either the " +
          "scanner broke, or $name no longer builds a regex: update anchorFiles in this test.",
        found.any { it.location.substringBefore(':').endsWith("/$name") },
      )
    }

    val violations = found.flatMap { site ->
      val problems = site.pattern?.let(IcuRegexSyntax::problems) ?: listOf(site.reason)
      problems.map { "${site.location}: $it  [${site.pattern ?: "<dynamic>"}]" }
    }
    assertTrue(
      "Regex patterns that Android's ICU engine may reject (#9947):\n" +
        violations.joinToString("\n"),
      violations.isEmpty(),
    )
  }

  @Test
  fun `scanner extracts literal and dynamic regex construction`() {
    val source =
      """
      val a = Regex("\\{x\\}")
      val b = "[a-z]+".toRegex()
      val c = Regex(${'"'}${'"'}${'"'}^\d{2}${'"'}${'"'}${'"'})
      val d = Pattern.compile("a}")
      val e = Regex(dynamicValue)
      val f = Regex("pre${'$'}{suffix}")
      // Regex("{") in a comment is ignored
      val g = "Regex(" + "text"
      """
        .trimIndent()
    val sites = RegexLiteralScanner.scan(source, "Fake.kt")
    assertEquals(
      listOf("\\{x\\}", "[a-z]+", "^\\d{2}", "a}", null, null),
      sites.map { it.pattern },
    )
    assertEquals(listOf(1, 2, 3, 4, 5, 6), sites.map { it.line })
  }

  private fun mainSourceFiles(): List<File> {
    val android = locateAndroidDir()
    return listOf("control-proxy", "protocol").flatMap { module ->
      File(android, "$module/src/main").walkTopDown().filter { it.extension == "kt" }.toList()
    }
  }

  private fun locateAndroidDir(): File {
    var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (dir != null) {
      listOf(dir, File(dir, "android")).forEach {
        if (
          File(it, "control-proxy/src/main").isDirectory &&
            File(it, "protocol/src/main").isDirectory
        ) {
          return it
        }
      }
      dir = dir.parentFile
    }
    error("Could not locate the android/ directory from user.dir")
  }
}

/** One place a regex is built: either a literal [pattern], or a [reason] it could not be read. */
data class RegexSite(val location: String, val line: Int, val pattern: String?, val reason: String)

/**
 * Finds `Regex(<literal>)`, `Pattern.compile(<literal>)` and `<literal>.toRegex()` in Kotlin
 * source, skipping comments, and reports non-literal or templated arguments as unreadable.
 */
object RegexLiteralScanner {
  private val constructors = listOf("Regex(", "Pattern.compile(")

  fun scan(source: String, path: String): List<RegexSite> {
    val sites = mutableListOf<RegexSite>()
    var i = 0
    while (i < source.length) {
      i =
        when {
          source.startsWith("//", i) ->
            source.indexOf('\n', i).let { if (it < 0) source.length else it }
          source.startsWith("/*", i) ->
            source.indexOf("*/", i).let { if (it < 0) source.length else it + 2 }
          source[i] == '\'' -> skipCharLiteral(source, i)
          source[i] == '"' -> readLiteral(source, i, path, sites)
          else -> constructorCall(source, i, path, sites) ?: (i + 1)
        }
    }
    return sites
  }

  private fun skipCharLiteral(s: String, start: Int): Int =
    if (s.getOrNull(start + 1) == '\\')
      s.indexOf('\'', start + 2).let { if (it < 0) s.length else it + 1 }
    else start + 3

  /** A non-literal argument: `Regex(someValue)` where the `(` is not followed by a quote. */
  private fun constructorCall(
    s: String,
    i: Int,
    path: String,
    sites: MutableList<RegexSite>,
  ): Int? {
    val call = constructors.firstOrNull {
      s.startsWith(it, i) && !isIdentifierPart(s.getOrNull(i - 1))
    }
    val afterParen = call?.let { i + it.length }
    val next = afterParen?.let { p -> s.indexOfFirst(p) { c -> !c.isWhitespace() } }
    val isLiteralArg = next != null && next >= 0 && s[next] == '"'
    if (call != null && !isLiteralArg) {
      sites +=
        RegexSite(
          "$path:${lineOf(s, i)}",
          lineOf(s, i),
          null,
          "non-literal pattern argument to $call",
        )
    }
    return afterParen
  }

  private fun String.indexOfFirst(from: Int, predicate: (Char) -> Boolean): Int {
    var i = from
    while (i < length && !predicate(this[i])) i++
    return if (i < length) i else -1
  }

  private fun isIdentifierPart(c: Char?): Boolean = c != null && (c.isLetterOrDigit() || c == '_')

  /**
   * Reads the string literal at [start]; records it if it feeds a regex. Returns the next index.
   */
  private fun readLiteral(s: String, start: Int, path: String, sites: MutableList<RegexSite>): Int {
    val raw = s.startsWith("\"\"\"", start)
    val bodyStart = start + if (raw) 3 else 1
    val end = if (raw) rawEnd(s, bodyStart) else stringEnd(s, bodyStart)
    val body = s.substring(bodyStart, minOf(end, s.length))
    val after = end + if (raw) 3 else 1
    val before = s.substring(maxOf(0, start - 40), start).trimEnd()
    val feedsRegex =
      constructors.any { before.endsWith(it) } || s.startsWith(".toRegex(", minOf(after, s.length))
    if (feedsRegex) {
      val line = lineOf(s, start)
      val templated = Regex("\\$[A-Za-z_{`]").containsMatchIn(body)
      sites +=
        if (templated) RegexSite("$path:$line", line, null, "templated pattern string")
        else RegexSite("$path:$line", line, if (raw) body else unescape(body), "")
    }
    return minOf(after, s.length)
  }

  private fun rawEnd(s: String, from: Int): Int {
    var i = s.indexOf("\"\"\"", from)
    if (i < 0) return s.length
    while (s.startsWith("\"", i + 3)) i++
    return i
  }

  private fun stringEnd(s: String, from: Int): Int {
    var i = from
    while (i < s.length && s[i] != '"') i += if (s[i] == '\\') 2 else 1
    return i
  }

  private fun unescape(body: String): String {
    val out = StringBuilder()
    var i = 0
    while (i < body.length) {
      val c = body[i]
      if (c != '\\' || i + 1 >= body.length) {
        out.append(c)
        i++
        continue
      }
      val next = body[i + 1]
      if (next == 'u' && body.length >= i + 6) {
        out.append(body.substring(i + 2, i + 6).toInt(16).toChar())
        i += 6
      } else {
        out.append(
          when (next) {
            'n' -> '\n'
            't' -> '\t'
            'r' -> '\r'
            'b' -> '\b'
            else -> next
          }
        )
        i += 2
      }
    }
    return out.toString()
  }

  private fun lineOf(s: String, index: Int): Int = s.substring(0, index).count { it == '\n' } + 1
}

/**
 * Approximation of the places where `java.util.regex` on the desktop JVM is more permissive than
 * Android's ICU-backed engine. Returns human-readable problems, empty when none are found. Pure
 * string handling, so it runs on the JVM.
 */
object IcuRegexSyntax {
  private val quantifier = Regex("\\{[0-9]+(?:,[0-9]*)?\\}")
  private const val UNSUPPORTED_ESCAPES = "hHRXN"

  fun problems(pattern: String): List<String> {
    val out = mutableListOf<String>()
    var i = 0
    var classDepth = 0
    while (i < pattern.length) {
      val step =
        when {
          pattern[i] == '\\' -> scanEscape(pattern, i, out)
          classDepth > 0 -> scanClassChar(pattern, i, out).also { classDepth += it.second }.first
          else -> scanTopLevel(pattern, i, out).also { classDepth += it.second }.first
        }
      i = step
    }
    return out
  }

  private fun scanEscape(p: String, i: Int, out: MutableList<String>): Int {
    val next = p.getOrNull(i + 1)
    return when {
      next == null -> {
        out += "trailing backslash at index $i"
        i + 1
      }
      next == 'Q' -> p.indexOf("\\E", i).let { if (it < 0) p.length else it + 2 }
      next in UNSUPPORTED_ESCAPES -> {
        out += "\\$next at index $i is not guaranteed on Android"
        i + 2
      }
      next in "pPxN" && p.getOrNull(i + 2) == '{' ->
        p.indexOf('}', i).let { if (it < 0) p.length else it + 1 }
      else -> i + 2
    }
  }

  /** Returns (next index, change in character-class depth). */
  private fun scanClassChar(p: String, i: Int, out: MutableList<String>): Pair<Int, Int> =
    when {
      p[i] == '[' -> openClass(p, i, out)
      p[i] == ']' -> (i + 1) to -1
      p.startsWith("&&", i) -> {
        out += "'&&' class intersection at index $i is JVM syntax (ICU uses '&')"
        (i + 2) to 0
      }
      else -> (i + 1) to 0
    }

  private fun openClass(p: String, i: Int, out: MutableList<String>): Pair<Int, Int> {
    var next = i + 1
    if (p.getOrNull(next) == '^') next++
    if (p.getOrNull(next) == ']') out += "']' opening a character class at index $next is ambiguous"
    return next to 1
  }

  private fun scanTopLevel(p: String, i: Int, out: MutableList<String>): Pair<Int, Int> =
    when {
      p[i] == '[' -> openClass(p, i, out)
      p[i] == ']' -> {
        out += "unescaped ']' at index $i"
        (i + 1) to 0
      }
      p[i] == '}' -> {
        out += "unescaped '}' at index $i (ICU rejects it)"
        (i + 1) to 0
      }
      p[i] == '{' -> {
        val q = quantifier.find(p, i)?.takeIf { it.range.first == i }
        if (q == null) out += "unescaped '{' at index $i that is not a valid quantifier"
        (if (q == null) i + 1 else q.range.last + 1) to 0
      }
      p.startsWith("(?<=", i) || p.startsWith("(?<!", i) -> {
        out += "lookbehind at index $i needs a bounded length on ICU; review"
        (i + 4) to 0
      }
      p.startsWith("(?<", i) -> {
        out += "named group at index $i is only available on newer Android; review"
        (i + 3) to 0
      }
      else -> (i + 1) to 0
    }
}
