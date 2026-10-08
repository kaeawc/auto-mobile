package dev.jasonpearson.automobile.design.system.components

import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * Icon-only button. Keeps Material's 48dp touch target and carries no crayon border, so existing
 * icon buttons render exactly as before; the shader path reaches them through this wrapper.
 */
@Composable
fun AutoMobileIconButton(
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  content: @Composable () -> Unit,
) {
  IconButton(onClick = onClick, modifier = modifier, enabled = enabled, content = content)
}
