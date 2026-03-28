package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import dev.jasonpearson.automobile.desktop.core.components.SearchBar
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.delay

/**
 * Category definitions for telemetry event filtering.
 * Multi-select: zero or more categories can be active simultaneously.
 */
internal enum class EventCategory(val label: String, val icon: String) {
    Network("Network", "\uD83C\uDF10"),           // 🌐
    Navigation("Nav", "\uD83E\uDDED"),             // 🧭
    Logs("Logs", "\uD83D\uDCDD"),                  // 📝
    Os("OS", "\u2699\uFE0F"),                      // ⚙️
    Custom("Custom", "\uD83C\uDFF7\uFE0F"),        // 🏷️
    Failures("Failures", "\uD83D\uDCA5"),          // 💥
    Storage("Storage", "\uD83D\uDDC4\uFE0F"),      // 🗄️
    Layout("Layout", "\uD83C\uDFD7\uFE0F"),        // 🏗️
    Performance("Perf", "\uD83D\uDCCA"),           // 📊
    ToolCalls("Tools", "\uD83D\uDD27"),            // 🔧
}

/**
 * Filter bar composable at the top of the center pane.
 * Shows multi-select category chips, a debounced search field, pause/resume, and clear.
 */
@Composable
fun EventFilterBar(
    filterState: TelemetryFilterState,
    modifier: Modifier = Modifier,
) {
    val colors = SharedTheme.globalColors

    var localQuery by remember { mutableStateOf(filterState.searchQuery) }
    LaunchedEffect(localQuery) {
        delay(150)
        filterState.searchQuery = localQuery
    }

    // Sync external changes (e.g. clear button, timeline scrub) back to local field
    LaunchedEffect(filterState.searchQuery) {
        if (filterState.searchQuery != localQuery) {
            localQuery = filterState.searchQuery
        }
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            modifier = Modifier
                .weight(1f)
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            EventCategory.entries.forEach { category ->
                val isSelected = filterState.selectedCategories.isEmpty() ||
                    category.name in filterState.selectedCategories
                Box(
                    modifier = Modifier
                        .background(
                            if (isSelected) colors.text.normal.copy(alpha = 0.12f) else Color.Transparent,
                            RoundedCornerShape(6.dp),
                        )
                        .clickable {
                            val current = filterState.selectedCategories
                            filterState.selectedCategories = if (current.isEmpty()) {
                                // First click from "all": select only this category
                                setOf(category.name)
                            } else if (category.name in current) {
                                val next = current - category.name
                                // If removing last selection, revert to "all"
                                if (next.isEmpty()) emptySet() else next
                            } else {
                                current + category.name
                            }
                        }
                        .pointerHoverIcon(PointerIcon.Hand)
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                ) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(category.icon, fontSize = 11.sp)
                        Text(
                            category.label,
                            fontSize = 11.sp,
                            color = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.5f),
                        )
                    }
                }
            }
        }

        Spacer(Modifier.width(8.dp))

        SearchBar(
            query = localQuery,
            onQueryChange = { localQuery = it },
            placeholder = "Filter events...",
            modifier = Modifier.width(200.dp),
        )

        Spacer(Modifier.width(4.dp))

        val buttonModifier = Modifier
            .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(horizontal = 6.dp, vertical = 4.dp)

        Box(
            modifier = Modifier
                .clickable { filterState.isPaused = !filterState.isPaused }
                .then(buttonModifier)
                .then(
                    if (filterState.isPaused) {
                        Modifier.background(Color(0xFFFFA94D).copy(alpha = 0.15f), RoundedCornerShape(4.dp))
                    } else {
                        Modifier
                    }
                ),
        ) {
            Text(if (filterState.isPaused) "\u25B6" else "\u23F8", fontSize = 13.sp)
        }

        Box(
            modifier = Modifier
                .clickable {
                    filterState.selectedCategories = emptySet()
                    filterState.searchQuery = ""
                    localQuery = ""
                }
                .then(buttonModifier),
        ) {
            Text("\u2715", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.6f))
        }
    }
}
