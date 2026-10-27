package dev.jasonpearson.automobile.desktop.core.failures

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun FailureListMemory.DateRangeSelector() {
  val colors = SharedTheme.globalColors
  Row(
    horizontalArrangement = Arrangement.spacedBy(4.dp),
    modifier =
      Modifier.background(
          colors.text.normal.copy(alpha = 0.05f),
          RoundedCornerShape(6.dp),
        )
        .padding(4.dp),
  ) {
    DateRange.entries.forEach { range ->
      val isSelected = range == dateRange
      Box(
        modifier =
          Modifier.background(
              if (isSelected) colors.text.normal.copy(alpha = 0.15f) else Color.Transparent,
              RoundedCornerShape(4.dp),
            )
            .clickable { dateRange = range }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(horizontal = 8.dp, vertical = 4.dp),
      ) {
        Text(
          range.label,
          fontSize = 10.sp,
          color = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.6f),
          maxLines = 1,
        )
      }
    }
  }
}

@Composable
internal fun FailureListMemory.AggregationSelector(validAggregations: List<TimeAggregation>) {
  val colors = SharedTheme.globalColors
  Row(
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      "Group by:",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
      maxLines = 1,
    )
    Row(
      horizontalArrangement = Arrangement.spacedBy(4.dp),
      modifier =
        Modifier.background(
            colors.text.normal.copy(alpha = 0.05f),
            RoundedCornerShape(6.dp),
          )
          .padding(4.dp),
    ) {
      validAggregations.forEach { agg ->
        val isSelected = agg == timeAggregation
        Box(
          modifier =
            Modifier.background(
                if (isSelected) colors.text.normal.copy(alpha = 0.15f) else Color.Transparent,
                RoundedCornerShape(4.dp),
              )
              .clickable { timeAggregation = agg }
              .pointerHoverIcon(PointerIcon.Hand)
              .padding(horizontal = 8.dp, vertical = 4.dp),
        ) {
          Text(
            agg.label,
            fontSize = 10.sp,
            color = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.6f),
            maxLines = 1,
          )
        }
      }
    }
  }
}

@Composable
internal fun FailureTypeFilters(filterType: FailureType?, onFilterChanged: (FailureType?) -> Unit) {
  BoxWithConstraints(modifier = Modifier.padding(bottom = 12.dp)) {
    val showLabels = maxWidth > 300.dp
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      FilterChip(
        label = "All",
        isSelected = filterType == null,
        showLabel = true, // Always show "All"
        onClick = { onFilterChanged(null) },
      )
      FailureType.entries.forEach { type ->
        FilterChip(
          label = type.label,
          icon = type.icon,
          isSelected = filterType == type,
          showLabel = showLabels,
          onClick = { onFilterChanged(type) },
        )
      }
    }
  }
}

@Composable
internal fun FilterChip(
  label: String,
  icon: String? = null,
  isSelected: Boolean,
  showLabel: Boolean = true,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  val bgColor = if (isSelected) colors.text.normal.copy(alpha = 0.15f) else Color.Transparent
  val borderColor =
    if (isSelected) colors.text.normal.copy(alpha = 0.3f) else colors.text.normal.copy(alpha = 0.2f)

  val displayText =
    when {
      icon != null && showLabel -> "$icon $label"
      icon != null -> icon
      else -> label
    }

  Box(
    modifier =
      Modifier.background(bgColor, RoundedCornerShape(4.dp))
        .border(1.dp, borderColor, RoundedCornerShape(4.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 10.dp, vertical = 4.dp),
  ) {
    Text(displayText, fontSize = 11.sp, maxLines = 1)
  }
}
