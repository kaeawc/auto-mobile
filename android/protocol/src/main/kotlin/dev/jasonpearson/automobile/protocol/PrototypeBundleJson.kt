package dev.jasonpearson.automobile.protocol

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import kotlinx.serialization.json.*

/**
 * Grammar/coercion remain owned by the existing parser; this bounded token walk rejects aliases.
 */
internal object PrototypeBundleJson {
  fun parse(bytes: ByteArray, code: PrototypeBundleErrorCode, path: String): JsonElement =
    try {
      val text =
        Charsets.UTF_8.newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes))
          .toString()
          .removePrefix("\uFEFF")
      Scanner(text).check()
      val value = PrototypeSpecContract.json.parseToJsonElement(text)
      require(PrototypeSpecInput.validNumberTokens(value))
      value
    } catch (_: IllegalArgumentException) {
      throw PrototypeBundleFailure(code, path)
    } catch (_: java.nio.charset.CharacterCodingException) {
      throw PrototypeBundleFailure(code, path)
    }

  private class Scanner(private val text: String) {
    private var at = 0

    private fun space() {
      while (at < text.length && text[at] in " \t\r\n") at++
    }

    private fun take(c: Char): Boolean {
      space()
      return if (text.getOrNull(at) == c) {
        at++
        true
      } else false
    }

    fun check() {
      value(0)
      space()
      require(at == text.length)
    }

    private fun string(): String {
      space()
      require(text.getOrNull(at) == '"')
      val start = at++
      while (at < text.length) {
        val c = text[at++]
        require(c.code >= 32)
        if (c == '"')
          return PrototypeSpecContract.json.decodeFromString<String>(text.substring(start, at))
        if (c == '\\') {
          require(at < text.length)
          val escape = text[at++]
          require(escape in "\"\\/bfnrtu")
          if (escape == 'u') {
            require(
              at + 4 <= text.length &&
                text.substring(at, at + 4).all { it in "0123456789abcdefABCDEF" },
            )
            at += 4
          }
        }
      }
      throw IllegalArgumentException("Unterminated JSON string")
    }

    private fun value(depth: Int) {
      require(depth <= PrototypeBundleLimits.MAX_JSON_DEPTH)
      space()
      when (text.getOrNull(at)) {
        '{' -> objectValue(depth)
        '[' -> {
          at++
          if (!take(']')) {
            do {
              value(depth + 1)
            } while (take(','))
            require(take(']'))
          }
        }
        '"' -> string()
        else -> {
          val start = at
          while (at < text.length && text[at] !in " \t\r\n,]}") at++
          val token = text.substring(start, at)
          require(
            token in setOf("true", "false", "null") ||
              PrototypeSpecContract.numberTokenPattern.matches(token),
          )
        }
      }
    }

    private fun objectValue(depth: Int) {
      at++
      val keys = HashSet<String>()
      if (take('}')) return
      do {
        require(keys.add(string()))
        require(take(':'))
        value(depth + 1)
      } while (take(','))
      require(take('}'))
    }
  }
}
