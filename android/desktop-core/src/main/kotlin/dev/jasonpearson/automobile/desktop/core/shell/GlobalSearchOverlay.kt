package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/** Category for grouping search results. */
enum class SearchCategory(val displayName: String) {
  TelemetryEvent("Telemetry Events"),
  HierarchyElement("Hierarchy Elements"),
  NavigationScreen("Navigation Screens"),
}

/** A single search result with category, label, and preview text. */
data class SearchResult(
    val id: String,
    val category: SearchCategory,
    val label: String,
    val preview: String,
    val onSelect: () -> Unit,
)

/**
 * Provider interface for global search results. Implementations query telemetry events, hierarchy
 * elements, and navigation screens.
 */
interface SearchResultProvider {
  fun search(query: String): List<SearchResult>
}

/**
 * Global search overlay triggered by Cmd+Shift+F. Searches across telemetry events, hierarchy
 * elements, and navigation screens. Results are grouped by category with headers.
 */
@Composable
fun GlobalSearchOverlay(
    searchProvider: SearchResultProvider,
    onDismiss: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  var query by remember { mutableStateOf("") }
  val results =
      remember(query) {
        if (query.isBlank()) emptyList() else searchProvider.search(query)
      }
  val flatItems = remember(results) { buildFlatItems(results) }
  var selectedIndex by remember { mutableIntStateOf(0) }
  val focusRequester = remember { FocusRequester() }

  LaunchedEffect(Unit) { focusRequester.requestFocus() }
  LaunchedEffect(flatItems.size) {
    if (selectedIndex >= flatItems.size) selectedIndex = 0
  }

  Box(
      modifier =
          Modifier.fillMaxSize()
              .background(colors.text.normal.copy(alpha = 0.4f))
              .clickable(onClick = onDismiss),
      contentAlignment = Alignment.TopCenter,
  ) {
    Column(
        modifier =
            Modifier.padding(top = 80.dp)
                .widthIn(max = 600.dp)
                .fillMaxWidth(0.8f)
                .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(8.dp))
                .clickable(enabled = false, onClick = {})
                .onPreviewKeyEvent { event ->
                  if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                  when (event.key) {
                    Key.Escape -> {
                      onDismiss()
                      true
                    }
                    Key.DirectionDown -> {
                      if (flatItems.isNotEmpty()) {
                        selectedIndex = nextSelectableIndex(flatItems, selectedIndex, 1)
                      }
                      true
                    }
                    Key.DirectionUp -> {
                      if (flatItems.isNotEmpty()) {
                        selectedIndex = nextSelectableIndex(flatItems, selectedIndex, -1)
                      }
                      true
                    }
                    Key.Enter -> {
                      val item = flatItems.getOrNull(selectedIndex)
                      if (item is FlatItem.ResultItem) {
                        item.result.onSelect()
                        onDismiss()
                      }
                      true
                    }
                    else -> false
                  }
                },
    ) {
      TextField(
          value = query,
          onValueChange = { query = it },
          singleLine = true,
          placeholder = { Text("Search everywhere...") },
          modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
          textStyle = MaterialTheme.typography.bodyLarge,
      )

      LazyColumn(
          modifier = Modifier.fillMaxWidth().heightIn(max = 400.dp),
      ) {
        itemsIndexed(flatItems) { index, item ->
          when (item) {
            is FlatItem.Header -> {
              Text(
                  text = item.category.displayName,
                  fontSize = 11.sp,
                  fontWeight = FontWeight.SemiBold,
                  color = colors.text.normal.copy(alpha = 0.5f),
                  modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
              )
            }
            is FlatItem.ResultItem -> {
              val isSelected = index == selectedIndex
              val bg =
                  if (isSelected) {
                    MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
                  } else {
                    MaterialTheme.colorScheme.surface
                  }
              Row(
                  modifier =
                      Modifier.fillMaxWidth()
                          .background(bg)
                          .clickable {
                            item.result.onSelect()
                            onDismiss()
                          }
                          .padding(horizontal = 16.dp, vertical = 8.dp),
                  verticalAlignment = Alignment.CenterVertically,
              ) {
                Text(
                    text = item.result.label,
                    fontSize = 14.sp,
                    color = colors.text.normal,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.width(12.dp))
                Text(
                    text = item.result.preview,
                    fontSize = 12.sp,
                    color = colors.text.normal.copy(alpha = 0.4f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 200.dp),
                )
              }
            }
          }
        }
      }

      if (query.isNotBlank() && results.isEmpty()) {
        Box(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            contentAlignment = Alignment.Center,
        ) {
          Text(
              text = "No results found",
              fontSize = 13.sp,
              color = colors.text.normal.copy(alpha = 0.5f),
          )
        }
      }
    }
  }
}

/** Sealed type for flat list items: either a category header or a result row. */
internal sealed class FlatItem {
  data class Header(val category: SearchCategory) : FlatItem()

  data class ResultItem(val result: SearchResult) : FlatItem()
}

/** Build a flat list of headers and results for LazyColumn rendering. */
internal fun buildFlatItems(results: List<SearchResult>): List<FlatItem> {
  val grouped = results.groupBy { it.category }
  val items = mutableListOf<FlatItem>()
  for ((category, categoryResults) in grouped) {
    items.add(FlatItem.Header(category))
    categoryResults.forEach { items.add(FlatItem.ResultItem(it)) }
  }
  return items
}

/** Find the next selectable (non-header) index in the given direction. */
internal fun nextSelectableIndex(items: List<FlatItem>, current: Int, direction: Int): Int {
  if (items.isEmpty()) return 0
  var next = (current + direction).mod(items.size)
  var attempts = 0
  while (items[next] is FlatItem.Header && attempts < items.size) {
    next = (next + direction).mod(items.size)
    attempts++
  }
  return next
}
