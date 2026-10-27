package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import dev.jasonpearson.automobile.desktop.core.time.Clock
import dev.jasonpearson.automobile.desktop.core.time.SystemClock

@Composable
internal fun SectionHeader(title: String) {
  val colors = SharedTheme.globalColors
  Text(
    title,
    fontSize = 13.sp,
    fontWeight = FontWeight.Medium,
    color = colors.text.normal.copy(alpha = 0.7f),
    modifier = Modifier.padding(bottom = 8.dp),
  )
}

@Composable
internal fun ViewAllLink(
  text: String,
  onClick: () -> Unit,
) {
  Text(
    "$text →",
    fontSize = 11.sp,
    color = Color(0xFF2196F3),
    modifier =
      Modifier.clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(top = 8.dp, bottom = 4.dp),
  )
}

@Composable
internal fun DetailRow(label: String, value: String) {
  val colors = SharedTheme.globalColors
  Row {
    Text(
      "$label: ",
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
    Text(
      value,
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.9f),
    )
  }
}

@Composable
internal fun ScreenChip(
  name: String,
  isHighlighted: Boolean,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  val bgColor =
    if (isHighlighted) Color(0xFFE53935).copy(alpha = 0.15f)
    else colors.text.normal.copy(alpha = 0.08f)
  val borderColor =
    if (isHighlighted) Color(0xFFE53935).copy(alpha = 0.5f)
    else colors.text.normal.copy(alpha = 0.2f)
  val textColor = if (isHighlighted) Color(0xFFE53935) else colors.text.normal

  Box(
    modifier =
      Modifier.background(bgColor, RoundedCornerShape(4.dp))
        .border(1.dp, borderColor, RoundedCornerShape(4.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 10.dp, vertical = 6.dp),
  ) {
    Text(name, fontSize = 12.sp, color = textColor)
  }
}

@Composable
internal fun ActionCard(
  icon: String,
  title: String,
  description: String,
  modifier: Modifier = Modifier,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors

  Row(
    modifier =
      modifier
        .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(8.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(icon, fontSize = 24.sp)
    Spacer(Modifier.width(12.dp))
    Column {
      Text(
        title,
        fontSize = 12.sp,
        fontWeight = FontWeight.Medium,
      )
      Text(
        description,
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
    }
  }
}

internal fun formatTimeAgo(timestamp: Long, clock: Clock = SystemClock): String {
  val diff = clock.nowMs() - timestamp
  return when {
    diff < 60_000 -> "Just now"
    diff < 3600_000 -> "${diff / 60_000}m ago"
    diff < 86400_000 -> "${diff / 3600_000}h ago"
    else -> "${diff / 86400_000}d ago"
  }
}

@Composable
internal fun DurationStat(label: String, ms: Long) {
  val colors = SharedTheme.globalColors
  Column(horizontalAlignment = Alignment.CenterHorizontally) {
    Text("${ms}ms", fontSize = 12.sp, fontWeight = FontWeight.Medium)
    Text(label, fontSize = 9.sp, color = colors.text.normal.copy(alpha = 0.5f))
  }
}
