package dev.jasonpearson.automobile.desktop.core

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.PlatformIcons
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun DeviceImageRow(
  image: dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo,
  isBooting: Boolean = false,
  error: String? = null,
  onBoot: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  val isIos = image.platform.equals("ios", ignoreCase = true)

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
        .clickable(enabled = !isBooting, onClick = onBoot)
        .pointerHoverIcon(if (isBooting) PointerIcon.Default else PointerIcon.Hand)
        .padding(8.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Icon(
      imageVector = PlatformIcons.logo(isIos),
      contentDescription = PlatformIcons.contentDescription(isIos),
      tint = PlatformIcons.tint(isIos),
      modifier = Modifier.size(16.dp),
    )
    DeviceImageIdentity(image, error)
    Box(
      modifier =
        Modifier.background(
            when {
              error != null -> Color(0xFFE53935).copy(alpha = 0.15f)
              isBooting -> Color(0xFF2196F3).copy(alpha = 0.25f)
              else -> Color(0xFF2196F3).copy(alpha = 0.15f)
            },
            RoundedCornerShape(4.dp),
          )
          .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
      Text(
        when {
          error != null -> "Error"
          isBooting -> "..."
          else -> "Boot"
        },
        fontSize = 9.sp,
        maxLines = 1,
        softWrap = false,
        color =
          when {
            error != null -> Color(0xFFE53935)
            else -> Color(0xFF2196F3)
          },
      )
    }
  }
}

@Composable
internal fun androidx.compose.foundation.layout.RowScope.DeviceImageIdentity(
  image: dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo,
  error: String?,
) {
  val colors = SharedTheme.globalColors
  Column(modifier = Modifier.weight(1f)) {
    Text(
      image.name,
      fontSize = 11.sp,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
    if (error != null) {
      Text(
        error,
        fontSize = 9.sp,
        color = Color(0xFFE53935),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    } else {
      image.image.target?.let { target ->
        Text(
          target,
          fontSize = 9.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }
  }
}
