package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

/**
 * Semi-transparent dark backdrop that dismisses on click. Shared by ShortcutCheatSheet and
 * QuickJumpDialog.
 */
@Composable
fun ModalBackdrop(
    onDismiss: () -> Unit,
    backdropAlpha: Float = 0.5f,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
  Box(
      modifier =
          modifier
              .fillMaxSize()
              .background(Color.Black.copy(alpha = backdropAlpha))
              .clickable(
                  interactionSource = remember { MutableInteractionSource() },
                  indication = null,
                  onClick = onDismiss,
              ),
      contentAlignment = Alignment.Center,
  ) {
    content()
  }
}
