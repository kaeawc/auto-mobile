package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.platform.AppVersion
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

// Project repository from package.json's repository field.
const val ABOUT_PROJECT_URL = "https://github.com/kaeawc/auto-mobile"

fun aboutVersionText(version: AppVersion): String =
  when {
    !version.isDevelopment -> "Version ${version.raw}"
    version.raw == AppVersion.Dev.raw -> "Development build"
    else -> "Development build (${version.raw})"
  }

/** In-window About overlay; its lifetime follows the containing app window. */
@Composable
fun AboutDialog(
  version: AppVersion,
  onDismiss: () -> Unit,
  onOpenProjectUrl: () -> Unit = { openReleaseNotesInBrowser(ABOUT_PROJECT_URL) },
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  val focusRequester = remember { FocusRequester() }

  LaunchedEffect(Unit) { focusRequester.requestFocus() }

  ModalBackdrop(onDismiss = onDismiss, modifier = modifier) {
    Column(
      modifier =
        Modifier.widthIn(max = 400.dp)
          .onPreviewKeyEvent { event ->
            if (event.type == KeyEventType.KeyDown && event.key == Key.Escape) {
              onDismiss()
              true
            } else {
              false
            }
          }
          .focusRequester(focusRequester)
          .focusable()
          .clip(RoundedCornerShape(12.dp))
          .background(colors.panelBackground)
          .clickable(
            interactionSource = remember { MutableInteractionSource() },
            indication = null,
            onClick = {},
          )
          .padding(24.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Text(
        text = "AutoMobile",
        fontSize = 16.sp,
        fontWeight = FontWeight.Bold,
        color = colors.text.normal,
      )
      Spacer(Modifier.height(12.dp))
      Text(text = aboutVersionText(version), fontSize = 13.sp, color = colors.text.normal)
      Spacer(Modifier.height(8.dp))
      Text(
        text = ABOUT_PROJECT_URL,
        fontSize = 12.sp,
        color = colors.text.info,
        textDecoration = TextDecoration.Underline,
        modifier = Modifier.clickable(onClick = onOpenProjectUrl),
      )
      Spacer(Modifier.height(16.dp))
      TextButton(onClick = onDismiss) { Text("Close", color = colors.text.normal) }
    }
  }
}
