package dev.jasonpearson.automobile.protocol

import java.util.regex.Pattern

/**
 * Portable regex grammar: a group repeated more than once must not transitively contain alternation
 * or any variable quantifier (max > min). At most two variable quantifiers are allowed in the
 * entire pattern to reject polynomial/exponential backtracking blowups. Optional groups and
 * repeated fixed sequences are legal. Bounds are <=100; source length counts UTF-16 units.
 */
data class PrototypeCheckPatternResult(val ok: Boolean, val message: String? = null)

object PrototypeCheckPattern {
  fun parse(pattern: String): PrototypeCheckPatternResult = Parser(pattern).parse()

  fun matches(pattern: String, value: String): Boolean {
    if (!parse(pattern).ok) return false
    return Pattern.compile(source(pattern)).matcher(value).matches()
  }

  // Java's default ASCII d/w/s classes match the portable grammar. Spell them out so platform
  // Unicode defaults cannot widen them. Escape Java-only class intersection syntax and ensure
  // dot excludes exactly the four JS line terminators (Java also excludes U+0085 by default).
  private fun source(pattern: String): String = buildString {
    var inClass = false
    var cursor = 0
    while (cursor < pattern.length) {
      val char = pattern[cursor++]
      if (char == '\\') {
        val next = pattern[cursor++]
        append(
          when (next) {
            'd' -> "[0-9]"
            'D' -> "[^0-9]"
            'w' -> "[A-Za-z0-9_]"
            'W' -> "[^A-Za-z0-9_]"
            's' -> "[ \\t\\r\\n\\f\\x0B]"
            'S' -> "[^ \\t\\r\\n\\f\\x0B]"
            else -> "\\$next"
          },
        )
      } else {
        when (char) {
          '[' -> {
            if (inClass) append("\\[")
            else {
              inClass = true
              append(char)
            }
          }
          ']' -> {
            inClass = false
            append(char)
          }
          '&' -> if (inClass) append("\\&") else append(char)
          '.' -> if (inClass) append(char) else append("[^\\r\\n\\u2028\\u2029]")
          // Java's $ accepts a final line terminator even before another authored atom.
          // JS without multiline treats authored anchors as absolute boundaries.
          '$' -> if (inClass) append(char) else append("\\z")
          '^' -> if (inClass) append(char) else append("\\A")
          else -> append(char)
        }
      }
    }
  }

  private data class Body(var variable: Boolean = false, var alternation: Boolean = false)

  private class Parser(val source: String) {
    var cursor = 0
    var error: String? = null
    var variableQuantifiers = 0
    var variable = false

    fun parse(): PrototypeCheckPatternResult {
      if (source.length > 128)
        return PrototypeCheckPatternResult(false, "Pattern exceeds 128 characters")
      body(false)
      return PrototypeCheckPatternResult(error == null, error)
    }

    fun fail(message: String) {
      if (error == null) error = message
    }

    fun peek(): Char? = source.getOrNull(cursor)

    fun body(group: Boolean): Body {
      val body = Body()
      while (cursor < source.length && error == null) {
        val char = source[cursor]
        if (char == ')') {
          if (!group) fail("Unmatched closing group") else cursor++
          return body
        }
        if (char == '|') {
          body.alternation = true
          cursor++
          continue
        }
        val atom = atom()
        val maximum = quantifier()
        val repeated = maximum != null && maximum > 1
        if (maximum != null && (char == '^' || char == '$')) fail("Anchor cannot be quantified")
        if (repeated && atom != null && (atom.variable || atom.alternation)) {
          fail("Repeated group contains repetition or alternation")
        }
        body.variable = body.variable || variable || atom?.variable == true
        body.alternation = body.alternation || atom?.alternation == true
      }
      if (group && error == null) fail("Unclosed group")
      return body
    }

    fun atom(): Body? {
      when (source[cursor++]) {
        '\\' -> escape()
        '[' -> characterClass()
        '(' -> {
          if (peek() == '?') {
            if (source.startsWith("?:", cursor)) cursor += 2
            else {
              fail(groupError())
              return null
            }
          }
          return body(true)
        }
        '*',
        '+',
        '?',
        '{',
        '}',
        ']' -> fail("Unexpected metacharacter or quantifier")
      }
      return null
    }

    fun groupError(): String {
      val rest = source.substring(cursor)
      return when {
        rest.startsWith("?=") || rest.startsWith("?!") -> "Lookahead is not supported"
        rest.startsWith("?<=") || rest.startsWith("?<!") -> "Lookbehind is not supported"
        rest.startsWith("?<") -> "Named groups are not supported"
        else -> "Inline flags or unsupported group syntax"
      }
    }

    fun escape(): Int? {
      val char = peek()
      cursor++
      if (char == null) {
        fail("Trailing escape")
        return null
      }
      when {
        char in '0'..'9' || char == 'k' -> fail("Backreferences are not supported")
        char == 'p' || char == 'P' -> fail("Unicode property classes are not supported")
        char == 'b' || char == 'B' -> fail("Word boundaries are not supported")
        char !in "dwsDWS" && char !in "^$\\.*+?()[]{}|/-" -> fail("Unsupported escape \\$char")
      }
      return if (char in "dwsDWS") null else char.code
    }

    fun classAtom(): Int? {
      if (peek() == '\\') {
        cursor++
        return escape()
      }
      if (cursor >= source.length) {
        cursor++
        return null
      }
      val point = source.codePointAt(cursor)
      cursor += Character.charCount(point)
      return point
    }

    fun characterClass() {
      if (peek() == '^') cursor++
      var count = 0
      while (cursor < source.length && peek() != ']' && error == null) {
        val start = classAtom()
        count++
        if (peek() == '-' && source.getOrNull(cursor + 1) != ']') {
          cursor++
          val end = classAtom()
          if (start == null || end == null) fail("Character class range requires literal endpoints")
          else if (start > end) fail("Character class range is reversed")
        }
      }
      if (peek() != ']') fail("Unclosed character class") else cursor++
      if (count == 0) fail("Empty character class is not supported")
    }

    fun quantifier(): Double? {
      variable = false
      val maximum =
        when (peek()) {
          '?' -> {
            cursor++
            variable = true
            1.0
          }
          '*',
          '+' -> {
            cursor++
            variable = true
            Double.POSITIVE_INFINITY
          }
          '{' -> boundedQuantifier()
          else -> null
        }
      if (variable && ++variableQuantifiers > 2)
        fail("pattern has too many variable quantifiers (max 2)")
      if (maximum != null)
        when (peek()) {
          '?' -> fail("Lazy quantifiers are not supported")
          '+' -> fail("Possessive quantifiers are not supported")
          '*',
          '{' -> fail("Repeated quantifier is not supported")
        }
      return maximum
    }

    fun boundedQuantifier(): Double? {
      val match = bounds.find(source.substring(cursor))
      if (match == null) {
        fail("Malformed bounded quantifier")
        return null
      }
      val minimum = match.groupValues[1].toDouble()
      val upper = match.groups[2]?.value
      val maximum =
        if (upper == null) minimum
        else if (upper.isEmpty()) Double.POSITIVE_INFINITY else upper.toDouble()
      if (minimum > 100 || (maximum.isFinite() && maximum > 100))
        fail("Quantifier bounds must be <=100")
      else if (minimum > maximum) fail("Quantifier minimum exceeds maximum")
      variable = maximum > minimum
      cursor += match.value.length
      return maximum
    }
  }

  private val bounds = Regex("^\\{([0-9]+)(?:,([0-9]*))?\\}")
}
