package dev.jasonpearson.automobile.ctrlproxy

/**
 * Pure, Android-free structural helpers shared by the source-scan enforcement tests
 * ([BroadcastGuardScanner] and [LaunchCancellationScanner]). Test-only — lives in the test source
 * set and ships no scanning code in the app.
 *
 * The load-bearing primitive is [maskLiteralsAndComments], which blanks the contents of every
 * string/char literal and comment (newlines preserved so line numbers and length are unchanged) so
 * structural brace/paren matching is not fooled by braces inside `"""{"type":...}"""`, a `${...}`
 * interpolation nesting a string, or a `// } comment`.
 */
object KotlinSourceScan {

  /** [open] must index a '('; returns the index just past the matching ')'. */
  fun matchParen(s: String, open: Int): Int {
    var depth = 0
    var i = open
    while (i < s.length) {
      when (s[i]) {
        '(' -> depth++
        ')' -> {
          depth--
          if (depth == 0) return i + 1
        }
      }
      i++
    }
    error("unbalanced parentheses starting at $open")
  }

  /** [open] must index a '{'; returns the index just past the matching '}'. */
  fun matchBrace(s: String, open: Int): Int {
    var depth = 0
    var i = open
    while (i < s.length) {
      when (s[i]) {
        '{' -> depth++
        '}' -> {
          depth--
          if (depth == 0) return i + 1
        }
      }
      i++
    }
    error("unbalanced braces starting at $open")
  }

  fun lineOf(source: String, index: Int): Int {
    var line = 1
    var i = 0
    while (i < index && i < source.length) {
      if (source[i] == '\n') line++
      i++
    }
    return line
  }

  /**
   * Replace the contents of every string/char literal and comment with spaces (newlines preserved,
   * so line numbers and length are unchanged), leaving real code structure -- braces, parens,
   * identifiers -- intact so structural matching is not fooled.
   *
   * A stack of lexer states handles the constructs that break a naive scan:
   * - Kotlin raw strings ("\"\"\"...\"\"\"") close on the *last* three quotes of a trailing run.
   * - String-template interpolation "${ ... }" is code, may nest strings that themselves contain
   *   braces/quotes (e.g. `"a ${f("}")}"`), and must not let an inner quote close the outer string.
   *   Interpolation contents are blanked but their braces are balanced (both blanked), so the
   *   surrounding code's brace/paren matching stays correct.
   */
  fun maskLiteralsAndComments(src: String): String {
    val out = StringBuilder(src.length)
    val n = src.length
    var i = 0
    // Parallel stacks: lexer state + (for INTERP) its running brace depth.
    val states = ArrayDeque<Int>().apply { addLast(CODE) }
    val interpDepth = ArrayDeque<Int>()

    fun blank(count: Int) {
      repeat(count) { out.append(' ') }
    }

    while (i < n) {
      val c = src[i]
      val next = if (i + 1 < n) src[i + 1] else ' '
      when (states.last()) {
        CODE,
        INTERP -> {
          when {
            c == '/' && next == '/' -> {
              states.addLast(LINE_COMMENT)
              blank(2)
              i += 2
            }
            c == '/' && next == '*' -> {
              states.addLast(BLOCK_COMMENT)
              blank(2)
              i += 2
            }
            c == '"' && next == '"' && i + 2 < n && src[i + 2] == '"' -> {
              states.addLast(RAW)
              blank(3)
              i += 3
            }
            c == '"' -> {
              states.addLast(STR)
              blank(1)
              i++
            }
            c == '\'' -> {
              states.addLast(CHAR)
              blank(1)
              i++
            }
            states.last() == INTERP && c == '{' -> {
              interpDepth.addLast(interpDepth.removeLast() + 1)
              blank(1)
              i++
            }
            states.last() == INTERP && c == '}' -> {
              val d = interpDepth.removeLast() - 1
              blank(1)
              i++
              if (d == 0) states.removeLast() else interpDepth.addLast(d)
            }
            states.last() == INTERP -> {
              out.append(if (c == '\n') '\n' else ' ')
              i++
            }
            else -> { // CODE: preserve real structure (braces, parens, identifiers).
              out.append(c)
              i++
            }
          }
        }
        STR -> {
          when {
            c == '\\' -> {
              blank(2)
              i += 2
            }
            c == '$' && next == '{' -> {
              states.addLast(INTERP)
              interpDepth.addLast(1)
              blank(2)
              i += 2
            }
            c == '"' -> {
              states.removeLast()
              blank(1)
              i++
            }
            else -> {
              out.append(if (c == '\n') '\n' else ' ')
              i++
            }
          }
        }
        RAW -> {
          when {
            c == '$' && next == '{' -> {
              states.addLast(INTERP)
              interpDepth.addLast(1)
              blank(2)
              i += 2
            }
            c == '"' -> {
              var run = 0
              while (i + run < n && src[i + run] == '"') run++
              blank(run)
              i += run
              if (run >= 3) states.removeLast() // last three quotes close the raw string
            }
            else -> {
              out.append(if (c == '\n') '\n' else ' ')
              i++
            }
          }
        }
        CHAR -> {
          when {
            c == '\\' -> {
              blank(2)
              i += 2
            }
            c == '\'' -> {
              states.removeLast()
              blank(1)
              i++
            }
            else -> {
              blank(1)
              i++
            }
          }
        }
        LINE_COMMENT -> {
          if (c == '\n') {
            states.removeLast()
            out.append('\n')
          } else {
            blank(1)
          }
          i++
        }
        else -> { // BLOCK_COMMENT
          if (c == '*' && next == '/') {
            states.removeLast()
            blank(2)
            i += 2
          } else {
            out.append(if (c == '\n') '\n' else ' ')
            i++
          }
        }
      }
    }
    return out.toString()
  }

  private const val CODE = 0
  private const val STR = 1 // regular string
  private const val RAW = 2 // raw triple-quoted string
  private const val CHAR = 3 // char literal
  private const val LINE_COMMENT = 4
  private const val BLOCK_COMMENT = 5
  private const val INTERP = 6 // ${ ... } string-template interpolation (code; brace depth tracked)
}
