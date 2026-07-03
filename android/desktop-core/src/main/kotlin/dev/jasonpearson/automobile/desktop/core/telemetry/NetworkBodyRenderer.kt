package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// JSON syntax colors
private val JSON_KEY_COLOR = Color(0xFF82AAFF) // light blue
private val JSON_STRING_COLOR = Color(0xFFC3E88D) // green
private val JSON_NUMBER_COLOR = Color(0xFFF78C6C) // orange
private val JSON_BOOLEAN_COLOR = Color(0xFFFF5370) // red-pink
private val JSON_NULL_COLOR = Color(0xFF676E95) // grey
private val JSON_BRACE_COLOR = Color(0xFFBBBBBB) // light grey

/** Renders a network body with content-type-aware formatting. */
@Composable
fun NetworkBodyContent(
  body: String?,
  contentType: String?,
  bodySize: Long,
  textColor: Color,
) {
  if (body.isNullOrBlank()) {
    val ct = contentType?.substringBefore(';')?.trim() ?: "unknown"
    val sizeText = formatByteSize(bodySize)
    if (bodySize > 0) {
      Text(
        "Binary content ($ct, $sizeText)",
        fontSize = 9.sp,
        color = textColor.copy(alpha = 0.4f),
      )
    } else {
      Text("No body", fontSize = 9.sp, color = textColor.copy(alpha = 0.35f))
    }
    return
  }

  val baseContentType = contentType?.substringBefore(';')?.trim()?.lowercase() ?: ""

  when {
    // Image: try to decode and display inline
    baseContentType.startsWith("image/") -> ImageBodyBlock(body, baseContentType, textColor)
    // JSON: pretty-print with syntax highlighting
    baseContentType.contains("json") || looksLikeJson(body) -> JsonBodyBlock(body, textColor)
    // XML / HTML: syntax-aware monospace
    baseContentType.contains("xml") ||
      baseContentType.contains("html") ||
      body.trimStart().startsWith("<") -> XmlBodyBlock(body, textColor)
    // Form data: key-value table
    baseContentType == "application/x-www-form-urlencoded" -> FormDataTable(body, textColor)
    // YAML
    baseContentType.contains("yaml") || baseContentType.contains("yml") ->
      YamlBodyBlock(body, textColor)
    // Check if content looks like binary garbage (non-printable chars)
    looksLikeBinary(body) -> {
      Text(
        "Binary content ($baseContentType, ${formatByteSize(body.length.toLong())})",
        fontSize = 9.sp,
        color = textColor.copy(alpha = 0.4f),
      )
    }
    // Fallback: plain monospace
    else -> PlainBodyBlock(body, textColor)
  }
}

/** Heuristic: if >20% of first 200 chars are non-printable, it's likely binary */
private fun looksLikeBinary(text: String): Boolean {
  val sample = text.take(200)
  val nonPrintable = sample.count { it < ' ' && it != '\n' && it != '\r' && it != '\t' }
  return nonPrintable > sample.length * 0.2
}

/** Heuristic: starts with { or [ after trimming whitespace */
private fun looksLikeJson(text: String): Boolean {
  val trimmed = text.trimStart()
  return trimmed.startsWith("{") || trimmed.startsWith("[")
}

/** Pretty-printed JSON with syntax coloring. */
@Composable
private fun JsonBodyBlock(body: String, textColor: Color) {
  val annotated = remember(body) { colorizeJson(body) }
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(textColor.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
        .horizontalScroll(rememberScrollState())
        .padding(8.dp)
  ) {
    Text(annotated, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
  }
}

/** Plain monospace text block. */
@Composable
private fun PlainBodyBlock(body: String, textColor: Color) {
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(textColor.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
        .horizontalScroll(rememberScrollState())
        .padding(8.dp)
  ) {
    Text(
      body,
      fontSize = 9.sp,
      fontFamily = FontFamily.Monospace,
      color = textColor.copy(alpha = 0.8f),
    )
  }
}

/** Render an image body — tries base64 decode, then raw bytes. */
@Composable
private fun ImageBodyBlock(body: String, contentType: String, textColor: Color) {
  val bitmap =
    remember(body) {
      try {
        // Try base64 first
        val bytes =
          try {
            java.util.Base64.getDecoder().decode(body.trim())
          } catch (_: Exception) {
            body.toByteArray(Charsets.ISO_8859_1)
          }
        org.jetbrains.skia.Image.makeFromEncoded(bytes).toComposeImageBitmap()
      } catch (_: Exception) {
        null
      }
    }
  if (bitmap != null) {
    Box(
      modifier =
        Modifier.fillMaxWidth()
          .background(textColor.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
          .padding(8.dp)
    ) {
      Image(
        bitmap = bitmap,
        contentDescription = "Response image",
        modifier = Modifier.fillMaxWidth().heightIn(max = 400.dp),
        contentScale = ContentScale.Fit,
      )
    }
  } else {
    Text(
      "Image ($contentType, ${formatByteSize(body.length.toLong())})",
      fontSize = 9.sp,
      color = textColor.copy(alpha = 0.4f),
    )
  }
}

/** XML/HTML with basic tag coloring. */
@Composable
private fun XmlBodyBlock(body: String, textColor: Color) {
  val annotated =
    remember(body, textColor) {
      buildAnnotatedString {
        var i = 0
        while (i < body.length) {
          if (body[i] == '<') {
            val end = body.indexOf('>', i)
            if (end > i) {
              withStyle(SpanStyle(color = Color(0xFF82AAFF))) {
                append(body.substring(i, end + 1))
              }
              i = end + 1
            } else {
              withStyle(SpanStyle(color = textColor.copy(alpha = 0.8f))) {
                append(body[i].toString())
              }
              i++
            }
          } else {
            withStyle(SpanStyle(color = textColor.copy(alpha = 0.8f))) {
              append(body[i].toString())
            }
            i++
          }
        }
      }
    }
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(textColor.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
        .horizontalScroll(rememberScrollState())
        .padding(8.dp)
  ) {
    Text(annotated, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
  }
}

/** YAML with basic key coloring. */
@Composable
private fun YamlBodyBlock(body: String, textColor: Color) {
  val annotated =
    remember(body, textColor) {
      buildAnnotatedString {
        body.lines().forEach { line ->
          val colonIndex = line.indexOf(':')
          if (
            colonIndex > 0 && !line.trimStart().startsWith("#") && !line.trimStart().startsWith("-")
          ) {
            withStyle(SpanStyle(color = Color(0xFF82AAFF))) {
              append(line.substring(0, colonIndex))
            }
            withStyle(SpanStyle(color = Color(0xFFBBBBBB))) { append(":") }
            withStyle(SpanStyle(color = Color(0xFFC3E88D))) {
              append(line.substring(colonIndex + 1))
            }
          } else if (line.trimStart().startsWith("#")) {
            withStyle(SpanStyle(color = Color(0xFF676E95))) { append(line) }
          } else {
            withStyle(SpanStyle(color = textColor.copy(alpha = 0.8f))) { append(line) }
          }
          append("\n")
        }
      }
    }
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(textColor.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
        .horizontalScroll(rememberScrollState())
        .padding(8.dp)
  ) {
    Text(annotated, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
  }
}

/** Form data rendered as a key-value table. */
@Composable
private fun FormDataTable(body: String, textColor: Color) {
  val pairs =
    remember(body) {
      body.split("&").mapNotNull { param ->
        val parts = param.split("=", limit = 2)
        if (parts.size == 2) {
          java.net.URLDecoder.decode(parts[0], "UTF-8") to
            java.net.URLDecoder.decode(parts[1], "UTF-8")
        } else null
      }
    }
  if (pairs.isEmpty()) {
    PlainBodyBlock(body, textColor)
    return
  }
  HeaderDataTable(pairs.toMap(), textColor)
}

/** Two-column data table for headers or form data with alternating row backgrounds. */
@Composable
fun HeaderDataTable(headers: Map<String, String>, textColor: Color) {
  if (headers.isEmpty()) {
    Text("No data", fontSize = 9.sp, color = textColor.copy(alpha = 0.35f))
    return
  }

  Column(
    modifier =
      Modifier.fillMaxWidth().background(textColor.copy(alpha = 0.03f), RoundedCornerShape(4.dp))
  ) {
    headers.entries.forEachIndexed { index, (key, value) ->
      Row(
        modifier =
          Modifier.fillMaxWidth()
            .then(
              if (index % 2 == 0) Modifier.background(textColor.copy(alpha = 0.04f)) else Modifier
            )
            .padding(horizontal = 8.dp, vertical = 3.dp)
      ) {
        Text(
          key,
          fontSize = 9.sp,
          fontWeight = FontWeight.SemiBold,
          fontFamily = FontFamily.Monospace,
          color = textColor.copy(alpha = 0.6f),
          modifier = Modifier.width(140.dp),
          maxLines = 1,
        )
        Text(
          value,
          fontSize = 9.sp,
          fontFamily = FontFamily.Monospace,
          color = textColor.copy(alpha = 0.85f),
          modifier = Modifier.weight(1f),
        )
      }
    }
  }
}

/** Format byte size to human-readable string. */
fun formatByteSize(bytes: Long): String =
  when {
    bytes < 0 -> "unknown"
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${"%.1f".format(bytes / 1024.0)} kB"
    else -> "${"%.1f".format(bytes / (1024.0 * 1024.0))} MB"
  }

// --- JSON syntax colorizer ---

private fun colorizeJson(raw: String): AnnotatedString {
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
          i = end + 1
        }
        c.isDigit() || c == '-' -> {
          val start = i
          while (
            i < pretty.length &&
              (pretty[i].isDigit() ||
                pretty[i] == '.' ||
                pretty[i] == '-' ||
                pretty[i] == 'e' ||
                pretty[i] == 'E' ||
                pretty[i] == '+')
          ) {
            i++
          }
          withStyle(SpanStyle(color = JSON_NUMBER_COLOR)) { append(pretty.substring(start, i)) }
        }
        pretty.startsWith("true", i) -> {
          withStyle(SpanStyle(color = JSON_BOOLEAN_COLOR)) { append("true") }
          i += 4
        }
        pretty.startsWith("false", i) -> {
          withStyle(SpanStyle(color = JSON_BOOLEAN_COLOR)) { append("false") }
          i += 5
        }
        pretty.startsWith("null", i) -> {
          withStyle(SpanStyle(color = JSON_NULL_COLOR)) { append("null") }
          i += 4
        }
        c == '{' || c == '}' || c == '[' || c == ']' || c == ':' || c == ',' -> {
          withStyle(SpanStyle(color = JSON_BRACE_COLOR)) { append(c.toString()) }
          i++
        }
        else -> {
          append(c.toString())
          i++
        }
      }
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
