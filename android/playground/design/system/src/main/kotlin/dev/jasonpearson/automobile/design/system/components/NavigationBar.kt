package dev.jasonpearson.automobile.design.system.components

import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarDefaults
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
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

/**
 * A tab inside [AutoMobileNavigationBar]. Icon and label slots stay with the caller so the
 * content descriptions and test tags that automation plans select on are unchanged.
 */
@Composable
fun RowScope.AutoMobileNavigationBarItem(
  selected: Boolean,
  onClick: () -> Unit,
  icon: @Composable () -> Unit,
  modifier: Modifier = Modifier,
  label: @Composable (() -> Unit)? = null,
) {
  NavigationBarItem(
    selected = selected,
    onClick = onClick,
    icon = icon,
    modifier = modifier,
    label = label,
    colors =
      NavigationBarItemDefaults.colors(
        selectedIconColor = MaterialTheme.colorScheme.primary,
        selectedTextColor = MaterialTheme.colorScheme.primary,
        unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
        unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
        indicatorColor = MaterialTheme.colorScheme.primaryContainer,
      ),
  )
}
