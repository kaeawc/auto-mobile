package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive

/** Preserve duplicate members and bound nesting before kotlinx's recursive tree parser. */
internal object PrototypeStrictJson {
  fun prepare(input: String): String {
    val source = input.removePrefix("\uFEFF")
    val stack = mutableListOf<MutableSet<String>?>()
    var cursor = 0
    while (cursor < source.length) {
      when (val character = source[cursor++]) {
        '"' -> {
          val start = cursor - 1
          while (cursor < source.length) {
            when (source[cursor++]) {
              '\\' -> cursor++
              '"' -> break
            }
          }
          require(cursor <= source.length) { "Invalid JSON" }
          val token = Json.parseToJsonElement(source.substring(start, cursor)).jsonPrimitive.content
          require(wellFormed(token)) { "Invalid Unicode JSON string" }
          var after = cursor
          while (after < source.length && source[after] in " \r\n\t") after++
          if (after < source.length && source[after] == ':') {
            require(stack.lastOrNull()?.add(token) != false) { "Duplicate JSON key" }
          }
        }
        '{',
        '[' -> {
          stack.add(if (character == '{') mutableSetOf() else null)
          require(stack.size <= 128) { "JSON nesting limit exceeded" }
        }
        '}',
        ']' -> if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex)
        else ->
          if (character == '-' || character in '0'..'9') {
            val start = cursor - 1
            while (cursor < source.length && source[cursor] !in " \r\n\t,]}:") cursor++
            require(source.substring(start, cursor).toDoubleOrNull()?.isFinite() != false) {
              "Nonfinite JSON number"
            }
          }
      }
    }
    return source
  }

  private fun wellFormed(value: String): Boolean {
    var cursor = 0
    while (cursor < value.length) {
      val character = value[cursor++]
      if (character.isHighSurrogate()) {
        if (cursor == value.length || !value[cursor++].isLowSurrogate()) return false
      } else if (character.isLowSurrogate()) return false
    }
    return true
  }
}
