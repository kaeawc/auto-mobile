package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.pager.PageSize
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypePagerPageSize
import dev.jasonpearson.automobile.protocol.PrototypePagerPeek

/** Pure option mappings; no composition, state, or device access. */
internal fun pagerContentPadding(axis: String?, peek: PrototypePagerPeek?): PaddingValues {
  val start = (peek?.start ?: 0.0).toFloat().dp
  val end = (peek?.end ?: 0.0).toFloat().dp
  return if (axis == "vertical") PaddingValues(top = start, bottom = end)
  else PaddingValues(start = start, end = end)
}

internal fun pagerPageSize(size: PrototypePagerPageSize?): PageSize =
  when (size) {
    is PrototypePagerPageSize.Dp -> PageSize.Fixed(size.dp.toFloat().dp)
    PrototypePagerPageSize.Fill,
    null -> PageSize.Fill
  }

internal fun pagerPageSpacing(spacing: Double?) = (spacing ?: 0.0).toFloat().dp
