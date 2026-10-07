package dev.jasonpearson.automobile.design.system.components

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ElevatedButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape

// Content-slot variants retain Material's sizing and caller-owned icon/text semantics.
// Unlike the text-only buttons, these do not impose a height on automation fixtures.

@Composable
fun AutoMobileContentButton(
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  colors: ButtonColors = ButtonDefaults.buttonColors(),
  contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
  shape: Shape = ButtonDefaults.shape,
  content: @Composable RowScope.() -> Unit,
) {
  Button(
    onClick = onClick,
    modifier = modifier.crayonBorder(MaterialTheme.colorScheme.outline).crayonGrain(shape),
    enabled = enabled,
    shape = shape,
    colors = colors,
    contentPadding = contentPadding,
    content = content,
  )
}

@Composable
fun AutoMobileContentOutlinedButton(
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  colors: ButtonColors = ButtonDefaults.outlinedButtonColors(),
  contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
  content: @Composable RowScope.() -> Unit,
) {
  OutlinedButton(
    onClick = onClick,
    modifier =
      modifier
        .crayonBorder(MaterialTheme.colorScheme.outline)
        .crayonGrain(ButtonDefaults.outlinedShape),
    enabled = enabled,
    colors = colors,
    contentPadding = contentPadding,
    content = content,
  )
}

@Composable
fun AutoMobileContentTextButton(
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  colors: ButtonColors = ButtonDefaults.textButtonColors(),
  contentPadding: PaddingValues = ButtonDefaults.TextButtonContentPadding,
  content: @Composable RowScope.() -> Unit,
) {
  TextButton(
    onClick = onClick,
    modifier =
      modifier
        .crayonBorder(MaterialTheme.colorScheme.outline)
        .crayonGrain(ButtonDefaults.textShape),
    enabled = enabled,
    colors = colors,
    contentPadding = contentPadding,
    content = content,
  )
}

@Composable
fun AutoMobileContentTonalButton(
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  colors: ButtonColors = ButtonDefaults.filledTonalButtonColors(),
  contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
  content: @Composable RowScope.() -> Unit,
) {
  FilledTonalButton(
    onClick = onClick,
    modifier =
      modifier
        .crayonBorder(MaterialTheme.colorScheme.outline)
        .crayonGrain(ButtonDefaults.filledTonalShape),
    enabled = enabled,
    colors = colors,
    contentPadding = contentPadding,
    content = content,
  )
}

@Composable
fun AutoMobileContentElevatedButton(
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  colors: ButtonColors = ButtonDefaults.elevatedButtonColors(),
  contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
  content: @Composable RowScope.() -> Unit,
) {
  ElevatedButton(
    onClick = onClick,
    modifier =
      modifier
        .crayonBorder(MaterialTheme.colorScheme.outline)
        .crayonGrain(ButtonDefaults.elevatedShape),
    enabled = enabled,
    colors = colors,
    contentPadding = contentPadding,
    content = content,
  )
}
