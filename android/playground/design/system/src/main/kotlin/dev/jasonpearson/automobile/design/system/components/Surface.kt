package dev.jasonpearson.automobile.design.system.components

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape

/** Plain filled container for bars and panels that are not cards. */
@Composable
fun AutoMobileSurface(
  modifier: Modifier = Modifier,
  shape: Shape = RectangleShape,
  color: Color = MaterialTheme.colorScheme.surface,
  contentColor: Color = MaterialTheme.colorScheme.onSurface,
  content: @Composable () -> Unit,
) {
  Surface(
    modifier = modifier,
    shape = shape,
    color = color,
    contentColor = contentColor,
    content = content,
  )
}
