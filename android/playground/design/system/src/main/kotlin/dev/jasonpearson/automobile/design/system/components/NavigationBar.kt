package dev.jasonpearson.automobile.design.system.components

import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/** Leaves item order, item semantics, label layout and insets under the caller's control. */
@Composable
fun AutoMobileNavigationBar(
  modifier: Modifier = Modifier,
  windowInsets: WindowInsets = NavigationBarDefaults.windowInsets,
  content: @Composable RowScope.() -> Unit,
) {
  NavigationBar(
    modifier =
      modifier.crayonHorizontalEdge(
        color = MaterialTheme.colorScheme.primary,
        atBottom = false,
        seed = 33L,
      ),
    windowInsets = windowInsets,
    content = content,
  )
}
