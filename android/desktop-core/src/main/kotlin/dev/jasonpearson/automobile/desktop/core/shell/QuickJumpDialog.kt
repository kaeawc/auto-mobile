package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/**
 * Parses a timestamp string like "15:30:00" or "15:30" into epoch millis relative to the start of
 * the current day (UTC). Returns null if unparseable.
 */
fun parseTimestampToMillis(input: String): Long? {
  val trimmed = input.trim()
  val parts = trimmed.split(":")
  if (parts.size !in 2..3) return null
  val hours = parts[0].toIntOrNull() ?: return null
  val minutes = parts[1].toIntOrNull() ?: return null
  val seconds = if (parts.size == 3) parts[2].toIntOrNull() ?: return null else 0
  if (hours !in 0..23 || minutes !in 0..59 || seconds !in 0..59) return null
  return ((hours * 3600L) + (minutes * 60L) + seconds) * 1000L
}

/**
 * Quick-jump dialog triggered by Cmd+K. Allows the user to type a timestamp (e.g., "15:30:00") and
 * jump to events around that time.
 */
@Composable
fun QuickJumpDialog(
  onJump: (Long) -> Unit,
  onDismiss: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  var text by remember { mutableStateOf("") }
  var errorMessage by remember { mutableStateOf<String?>(null) }
  val focusRequester = remember { FocusRequester() }

  LaunchedEffect(Unit) {
    focusRequester.requestFocus()
  }

  ModalBackdrop(onDismiss = onDismiss, backdropAlpha = 0.4f, modifier = modifier) {
    Column(
      modifier =
        Modifier.widthIn(max = 400.dp)
          .clip(RoundedCornerShape(12.dp))
          .background(colors.panelBackground)
          .clickable(
            interactionSource = remember { MutableInteractionSource() },
            indication = null,
            onClick = {},
          )
          .padding(20.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Text(
        text = "Jump to Timestamp",
        fontSize = 14.sp,
        fontWeight = FontWeight.Bold,
        color = colors.text.normal,
      )
      Spacer(Modifier.height(12.dp))

      BasicTextField(
        value = text,
        onValueChange = {
          text = it
          errorMessage = null
        },
        singleLine = true,
        textStyle =
          TextStyle(
            fontSize = 16.sp,
            color = colors.text.normal,
          ),
        cursorBrush = SolidColor(colors.text.info),
        modifier =
          Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(colors.text.normal.copy(alpha = 0.08f))
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .focusRequester(focusRequester)
            .onPreviewKeyEvent { event ->
              when {
                event.type == KeyEventType.KeyDown && event.key == Key.Enter -> {
                  val millis = parseTimestampToMillis(text)
                  if (millis != null) {
                    onJump(millis)
                    onDismiss()
                  } else {
                    errorMessage = "Enter a valid time (HH:MM or HH:MM:SS)"
                  }
                  true
                }
                event.type == KeyEventType.KeyDown && event.key == Key.Escape -> {
                  onDismiss()
                  true
                }
                else -> false
              }
            },
        decorationBox = { innerTextField ->
          Box {
            if (text.isEmpty()) {
              Text(
                text = "HH:MM:SS (e.g., 15:30:00)",
                fontSize = 16.sp,
                color = colors.text.normal.copy(alpha = 0.3f),
              )
            }
            innerTextField()
          }
        },
      )

      errorMessage?.let { msg ->
        Spacer(Modifier.height(6.dp))
        Text(
          text = msg,
          fontSize = 11.sp,
          color = colors.text.error,
        )
      }

      Spacer(Modifier.height(8.dp))
      Text(
        text = "Press Enter to jump, Escape to cancel",
        fontSize = 11.sp,
        color = colors.text.normal.copy(alpha = 0.4f),
      )
    }
  }
}
