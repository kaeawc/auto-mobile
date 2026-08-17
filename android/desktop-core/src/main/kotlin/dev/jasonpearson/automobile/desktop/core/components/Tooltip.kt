package dev.jasonpearson.automobile.desktop.core.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.TooltipArea
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Tooltip wrapper matching Jewel's Tooltip API. On desktop the [tooltip] content is shown in a
 * hover popup via Compose Desktop's [TooltipArea], so sighted mouse users see the same detail that
 * callers also mirror into semantics (e.g. the provenance summary on a faded navigation
 * node, #4985). The popup is wrapped in an elevated [Surface] so the content reads as a tooltip
 * over the underlying UI.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun Tooltip(
  tooltip: @Composable () -> Unit,
  modifier: Modifier = Modifier,
  content: @Composable () -> Unit,
) {
  TooltipArea(
    tooltip = {
      Surface(shape = RoundedCornerShape(4.dp), shadowElevation = 4.dp) {
        Box(modifier = Modifier.padding(8.dp)) { tooltip() }
      }
    },
    modifier = modifier,
  ) {
    content()
  }
}
