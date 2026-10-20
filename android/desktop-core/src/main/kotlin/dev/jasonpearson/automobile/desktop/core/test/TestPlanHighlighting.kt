package dev.jasonpearson.automobile.desktop.core.test

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.withStyle

@Composable
internal fun highlightYaml(yaml: String): AnnotatedString =
  remember(yaml) {
    PlanYamlHighlighter().highlight(yaml)
  }

private class PlanYamlHighlighter {
  private val keyColor = Color(0xFF4EC9B0)
  private val stringColor = Color(0xFFCE9178)
  private val numberColor = Color(0xFFB5CEA8)
  private val toolColor = Color(0xFFC586C0)
  private val commentColor = Color(0xFF6A9955)
  private val defaultColor = Color(0xFFD4D4D4)
  private val toolNames =
    setOf(
      "tapOn",
      "swipeOn",
      "dragAndDrop",
      "pinchOn",
      "sendKeys",
      "inputText",
      "clearText",
      "pressButton",
      "pressKey",
      "launchApp",
      "terminateApp",
      "installApp",
      "observe",
    )

  fun highlight(yaml: String): AnnotatedString {
    val builder = AnnotatedString.Builder()
    yaml.lines().forEachIndexed { index, line ->
      if (index > 0) builder.append("\n")
      appendLine(builder, line)
    }
    return builder.toAnnotatedString()
  }

  private fun appendLine(builder: AnnotatedString.Builder, line: String) {
    when {
      line.trimStart().startsWith("#") ->
        builder.withStyle(SpanStyle(color = commentColor)) { append(line) }
      line.contains(":") -> appendKeyValue(builder, line)
      line.trimStart().startsWith("-") -> appendListItem(builder, line)
      else -> builder.withStyle(SpanStyle(color = defaultColor)) { append(line) }
    }
  }

  private fun appendKeyValue(builder: AnnotatedString.Builder, line: String) {
    val colonIndex = line.indexOf(':')
    val key = line.substring(0, colonIndex)
    val value = line.substring(colonIndex + 1)
    builder.withStyle(SpanStyle(color = keyColor)) { append(key) }
    builder.withStyle(SpanStyle(color = defaultColor)) { append(":") }
    val trimmedValue = value.trim()
    val leadingSpaces = value.takeWhile { it == ' ' }
    builder.append(leadingSpaces)
    builder.withStyle(SpanStyle(color = valueColor(trimmedValue))) { append(trimmedValue) }
  }

  private fun valueColor(value: String): Color =
    when {
      toolNames.contains(value) -> toolColor
      isQuoted(value) -> stringColor
      value.matches(Regex("-?\\d+(\\.\\d+)?")) -> numberColor
      value in listOf("true", "false", "null", "~") -> numberColor
      else -> defaultColor
    }

  private fun isQuoted(value: String): Boolean {
    val doubleQuoted = value.startsWith("\"") && value.endsWith("\"")
    val singleQuoted = value.startsWith("'") && value.endsWith("'")
    return doubleQuoted || singleQuoted
  }

  private fun appendListItem(builder: AnnotatedString.Builder, line: String) {
    val indent = line.takeWhile { it == ' ' }
    val rest = line.drop(indent.length)
    builder.withStyle(SpanStyle(color = defaultColor)) { append(indent) }
    builder.withStyle(SpanStyle(color = keyColor)) { append("-") }
    if (rest.length > 1) builder.withStyle(SpanStyle(color = defaultColor)) { append(rest.drop(1)) }
  }
}
