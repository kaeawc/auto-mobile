package dev.jasonpearson.automobile.desktop.core.telemetry

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.formatUiNumber

/** Two-column data table for headers or form data with alternating row backgrounds. */
@Composable
fun HeaderDataTable(headers: Map<String, String>, textColor: Color) {
  if (headers.isEmpty()) {
    Text("No data", fontSize = 9.sp, color = textColor.copy(alpha = 0.35f))
    return
  }

  Column(
    modifier =
      Modifier.fillMaxWidth().background(textColor.copy(alpha = 0.03f), RoundedCornerShape(4.dp)),
  ) {
    headers.entries.forEachIndexed { index, (key, value) ->
      Row(
        modifier =
          Modifier.fillMaxWidth()
            .then(
              if (index % 2 == 0) Modifier.background(textColor.copy(alpha = 0.04f)) else Modifier,
            )
            .padding(horizontal = 8.dp, vertical = 3.dp),
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
    bytes < 1024 * 1024 -> "${formatUiNumber("%.1f", bytes / 1024.0)} kB"
    else -> "${formatUiNumber("%.1f", bytes / (1024.0 * 1024.0))} MB"
  }

@Composable
internal fun EmptyBodyContent(contentType: String?, bodySize: Long, textColor: Color) {
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
}
