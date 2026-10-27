package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle

internal fun buildSyntaxHighlightedJson(json: String, baseColor: Color): AnnotatedString =
  JsonSyntaxHighlighter(json, baseColor).build()

private data class JsonHighlightToken(val end: Int, val color: Color)

private class JsonSyntaxHighlighter(private val json: String, baseColor: Color) {
  private val keyColor = Color(0xFF82AAFF)
  private val stringColor = Color(0xFF98C379)
  private val numberColor = Color(0xFFE5C07B)
  private val keywordColor = Color(0xFFC678DD)
  private val defaultColor = baseColor.copy(alpha = 0.85f)

  fun build(): AnnotatedString = buildAnnotatedString {
    var index = 0
    while (index < json.length) {
      val token = tokenAt(index)
      withStyle(SpanStyle(color = token.color)) { append(json.substring(index, token.end)) }
      index = token.end
    }
  }

  private fun tokenAt(index: Int): JsonHighlightToken {
    val c = json[index]
    val keywordLength = keywordLength(index)
    return when {
      c == '"' -> {
        val end = stringEnd(index)
        JsonHighlightToken(end, if (isKey(end)) keyColor else stringColor)
      }
      keywordLength > 0 -> JsonHighlightToken(index + keywordLength, keywordColor)
      c == '-' || c.isDigit() -> JsonHighlightToken(numberEnd(index), numberColor)
      else -> JsonHighlightToken(index + 1, defaultColor)
    }
  }

  private fun keywordLength(index: Int): Int =
    when {
      json.startsWith("true", index) -> 4
      json.startsWith("false", index) -> 5
      json.startsWith("null", index) -> 4
      else -> 0
    }

  private fun stringEnd(index: Int): Int {
    var end = index + 1
    while (end < json.length) {
      if (json[end] == '\\') {
        end += 2
        continue
      }
      if (json[end] == '"') {
        end++
        break
      }
      end++
    }
    return end
  }

  private fun isKey(end: Int): Boolean {
    var next = end
    while (next < json.length && json[next] in " \t\n") next++
    return next < json.length && json[next] == ':'
  }

  private fun numberEnd(index: Int): Int {
    var end = index
    if (end < json.length && json[end] == '-') end++
    while (end < json.length && (json[end].isDigit() || json[end] in ".eE+-")) end++
    return end
  }
}
