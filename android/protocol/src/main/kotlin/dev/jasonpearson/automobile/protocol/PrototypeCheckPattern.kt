package dev.jasonpearson.automobile.protocol

import java.util.regex.Pattern
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive

/**
 * Portable regex grammar: a group repeated more than once must not transitively contain alternation
 * or any variable quantifier (max > min). At most two variable quantifiers are allowed in the
 * entire pattern to reject polynomial/exponential backtracking blowups. Optional groups and
 * repeated fixed sequences are legal. Bounds are <=100; source length counts UTF-16 units.
 */
data class PrototypeCheckPatternResult(val ok: Boolean, val message: String? = null)

object PrototypeCheckPattern {
  private val maxLength = PrototypeSpecContract.checkPatternMaxLength
  private val maxBound =
    PrototypeSpecContract.limits.getValue("MAX_PROTOTYPE_CHECK_QUANTIFIER_BOUND").jsonPrimitive.int
  private val maxVariable =
    PrototypeSpecContract.limits
      .getValue("MAX_PROTOTYPE_CHECK_VARIABLE_QUANTIFIERS")
      .jsonPrimitive
      .int

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
          escapedSource(next),
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
          '$',
          '^' -> append(anchorSource(char, inClass))
          else -> append(char)
        }
      }
    }
  }

  private fun anchorSource(char: Char, inClass: Boolean): String =
    if (inClass) char.toString() else if (char == '$') "\\z" else "\\A"

  private fun escapedSource(next: Char): String =
    when (next) {
      'd' -> "[0-9]"
      'D' -> "[^0-9]"
      'w' -> "[A-Za-z0-9_]"
      'W' -> "[^A-Za-z0-9_]"
      's' -> "[ \\t\\r\\n\\f\\x0B]"
      'S' -> "[^ \\t\\r\\n\\f\\x0B]"
      else -> "\\$next"
    }

  private fun groupError(rest: String): String {
    return when {
      rest.startsWith("?=") || rest.startsWith("?!") -> "Lookahead is not supported"
      rest.startsWith("?<=") || rest.startsWith("?<!") -> "Lookbehind is not supported"
      rest.startsWith("?<") -> "Named groups are not supported"
      else -> "Inline flags or unsupported group syntax"
    }
  }

  private data class Body(var variable: Boolean = false, var alternation: Boolean = false) {
    fun hasVariableOrAlternation(): Boolean = variable || alternation
  }

  private class Parser(val source: String) {
    var cursor = 0
    var error: String? = null
    var variableQuantifiers = 0
    var variable = false

    fun parse(): PrototypeCheckPatternResult {
      if (source.length > maxLength)
        return PrototypeCheckPatternResult(false, "Pattern exceeds $maxLength characters")
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
        readAtom(body, char)
      }
      if (group && error == null) fail("Unclosed group")
      return body
    }

    private fun readAtom(body: Body, char: Char) {
      val atom = atom()
      val maximum = quantifier()
      val repeated = maximum != null && maximum > 1
      if (maximum != null && (char == '^' || char == '$')) fail("Anchor cannot be quantified")
      if (repeated && atom?.hasVariableOrAlternation() == true) {
        fail("Repeated group contains repetition or alternation")
      }
      body.variable = body.variable || variable || atom?.variable == true
      body.alternation = body.alternation || atom?.alternation == true
    }

    fun atom(): Body? {
      when (source[cursor++]) {
        '\\' -> escape()
        '[' -> characterClass()
        '(' -> {
          if (peek() == '?') {
            if (source.startsWith("?:", cursor)) cursor += 2
            else {
              fail(groupError(source.substring(cursor)))
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
      if (variable && ++variableQuantifiers > maxVariable)
        fail("pattern has too many variable quantifiers (max $maxVariable)")
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
      if (minimum > maxBound || (maximum.isFinite() && maximum > maxBound))
        fail("Quantifier bounds must be <=$maxBound")
      else if (minimum > maximum) fail("Quantifier minimum exceeds maximum")
      variable = maximum > minimum
      cursor += match.value.length
      return maximum
    }
  }

  private val bounds = Regex("^\\{([0-9]+)(?:,([0-9]*))?\\}")
}
