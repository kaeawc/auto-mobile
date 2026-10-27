package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle

// JSON syntax colors
private val JSON_KEY_COLOR = Color(0xFF82AAFF) // light blue
private val JSON_STRING_COLOR = Color(0xFFC3E88D) // green
private val JSON_NUMBER_COLOR = Color(0xFFF78C6C) // orange
private val JSON_BOOLEAN_COLOR = Color(0xFFFF5370) // red-pink
private val JSON_NULL_COLOR = Color(0xFF676E95) // grey
private val JSON_BRACE_COLOR = Color(0xFFBBBBBB) // light grey

// --- JSON syntax colorizer ---

internal fun colorizeJson(raw: String): AnnotatedString {
  val pretty =
    try {
      val json = kotlinx.serialization.json.Json { prettyPrint = true }
      val element = json.parseToJsonElement(raw)
      json.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), element)
    } catch (_: Exception) {
      return AnnotatedString(raw)
    }

  return buildAnnotatedString {
    var i = 0
    while (i < pretty.length) {
      i = appendJsonToken(pretty, i)
    }
  }
}

private fun findStringEnd(s: String, start: Int): Int {
  var i = start + 1
  while (i < s.length) {
    if (s[i] == '\\') {
      i += 2
    } else if (s[i] == '"') {
      return i
    } else {
      i++
    }
  }
  return s.length - 1
}

private fun isNumberCharacter(char: Char): Boolean = char.isDigit() || char in ".-eE+"

private fun AnnotatedString.Builder.appendJsonToken(pretty: String, i: Int): Int {
  val c = pretty[i]
  when {
    c == '"' -> {
      // Find end of string
      val end = findStringEnd(pretty, i)
      val str = pretty.substring(i, end + 1)
      // Check if this is a key (followed by colon after optional whitespace)
      val afterStr = pretty.substring(end + 1).trimStart()
      if (afterStr.startsWith(":")) {
        // JSON key
        withStyle(SpanStyle(color = JSON_KEY_COLOR)) { append(str) }
      } else {
        // JSON string value
        withStyle(SpanStyle(color = JSON_STRING_COLOR)) { append(str) }
      }
      return end + 1
    }
    c.isDigit() || c == '-' -> {
      val start = i
      var end = i
      while (end < pretty.length && isNumberCharacter(pretty[end])) {
        end++
      }
      withStyle(SpanStyle(color = JSON_NUMBER_COLOR)) { append(pretty.substring(start, end)) }
      return end
    }
    pretty.startsWith("true", i) -> {
      withStyle(SpanStyle(color = JSON_BOOLEAN_COLOR)) { append("true") }
      return i + 4
    }
    pretty.startsWith("false", i) -> {
      withStyle(SpanStyle(color = JSON_BOOLEAN_COLOR)) { append("false") }
      return i + 5
    }
    pretty.startsWith("null", i) -> {
      withStyle(SpanStyle(color = JSON_NULL_COLOR)) { append("null") }
      return i + 4
    }
    c in "{}[]:," -> {
      withStyle(SpanStyle(color = JSON_BRACE_COLOR)) { append(c.toString()) }
      return i + 1
    }
    else -> {
      append(c.toString())
      return i + 1
    }
  }
}
