package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Renders a network body with content-type-aware formatting. */
@Composable
fun NetworkBodyContent(
  body: String?,
  contentType: String?,
  bodySize: Long,
  textColor: Color,
) {
  if (body.isNullOrBlank()) {
    EmptyBodyContent(contentType, bodySize, textColor)
    return
  }

  val baseContentType = contentType?.substringBefore(';')?.trim()?.lowercase() ?: ""

  when (networkBodyKind(body, baseContentType)) {
    NetworkBodyKind.Image -> ImageBodyBlock(body, baseContentType, textColor)
    NetworkBodyKind.Json -> JsonBodyBlock(body, textColor)
    NetworkBodyKind.Xml -> XmlBodyBlock(body, textColor)
    NetworkBodyKind.Form -> FormDataTable(body, textColor)
    NetworkBodyKind.Yaml -> YamlBodyBlock(body, textColor)
    NetworkBodyKind.Binary ->
      Text(
        "Binary content ($baseContentType, ${formatByteSize(body.length.toLong())})",
        fontSize = 9.sp,
        color = textColor.copy(alpha = 0.4f),
      )
    NetworkBodyKind.Plain -> PlainBodyBlock(body, textColor)
  }
}

/** Heuristic: if >20% of first 200 chars are non-printable, it's likely binary */
internal fun looksLikeBinary(text: String): Boolean {
  val sample = text.take(200)
  val nonPrintable = sample.count { it < ' ' && it != '\n' && it != '\r' && it != '\t' }
  return nonPrintable > sample.length * 0.2
}

/** Heuristic: starts with { or [ after trimming whitespace */
internal fun looksLikeJson(text: String): Boolean {
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
        .padding(8.dp),
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
        .padding(8.dp),
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
          .padding(8.dp),
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
        .padding(8.dp),
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
        .padding(8.dp),
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

private enum class NetworkBodyKind {
  Image,
  Json,
  Xml,
  Form,
  Yaml,
  Binary,
  Plain,
}

private fun networkBodyKind(body: String, baseContentType: String): NetworkBodyKind =
  when {
    baseContentType.startsWith("image/") -> NetworkBodyKind.Image
    baseContentType.contains("json") || looksLikeJson(body) -> NetworkBodyKind.Json
    baseContentType.contains("xml") ||
      baseContentType.contains("html") ||
      body.trimStart().startsWith("<") -> NetworkBodyKind.Xml
    baseContentType == "application/x-www-form-urlencoded" -> NetworkBodyKind.Form
    baseContentType.contains("yaml") || baseContentType.contains("yml") -> NetworkBodyKind.Yaml
    looksLikeBinary(body) -> NetworkBodyKind.Binary
    else -> NetworkBodyKind.Plain
  }
