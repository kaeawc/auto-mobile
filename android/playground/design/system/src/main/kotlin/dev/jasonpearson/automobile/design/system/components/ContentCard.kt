package dev.jasonpearson.automobile.design.system.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.material3.Card
import androidx.compose.material3.CardColors
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CardElevation
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape

/** Keeps caller-owned padding and content, including automation fixture click targets. */
@Composable
fun AutoMobileContentCard(
  modifier: Modifier = Modifier,
  shape: Shape = CardDefaults.shape,
  colors: CardColors = CardDefaults.cardColors(),
  elevation: CardElevation = CardDefaults.cardElevation(),
  border: BorderStroke? = null,
  content: @Composable ColumnScope.() -> Unit,
) {
  Card(
    modifier = modifier.crayonBorder(MaterialTheme.colorScheme.outline).crayonGrain(shape),
    shape = shape,
    colors = colors,
    elevation = elevation,
    border = border,
    content = content,
  )
}

/** Uses Material's clickable Card overload so its role and merged click node stay intact. */
@Composable
fun AutoMobileClickableCard(
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  shape: Shape = CardDefaults.shape,
  colors: CardColors = CardDefaults.cardColors(),
  elevation: CardElevation = CardDefaults.cardElevation(),
  border: BorderStroke? = null,
  content: @Composable ColumnScope.() -> Unit,
) {
  Card(
    onClick = onClick,
    modifier = modifier.crayonBorder(MaterialTheme.colorScheme.outline).crayonGrain(shape),
    enabled = enabled,
    shape = shape,
    colors = colors,
    elevation = elevation,
    border = border,
    content = content,
  )
}
