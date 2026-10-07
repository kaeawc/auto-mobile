package dev.jasonpearson.automobile.design.system.components

import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

@Composable
fun AutoMobileFilterChip(
  selected: Boolean,
  onClick: () -> Unit,
  label: @Composable () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
) {
  FilterChip(
    selected = selected,
    onClick = onClick,
    label = label,
    modifier =
      modifier
        .crayonBorder(MaterialTheme.colorScheme.outline)
        .crayonGrain(FilterChipDefaults.shape),
    enabled = enabled,
  )
}
