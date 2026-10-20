@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.layout

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.components.SearchBarOptions
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.delay

/** Flattened tree node for virtualized rendering. */
internal data class FlatTreeNode(
  val element: UIElementInfo,
  val depth: Int,
  val isExpanded: Boolean,
  val hasChildren: Boolean,
)

/**
 * Virtualized tree view of the UI element hierarchy. Supports:
 * - Expand/collapse nodes
 * - Search/filter with debounce
 * - Selection highlighting
 * - Auto-expand to selected element
 * - Hover highlighting
 */
data class HierarchyTreeOptions(
  val hierarchy: UIElementInfo?,
  val selectedElementId: String?,
  val hoveredElementId: String?,
  val onElementSelected: (String?) -> Unit,
  val onElementHovered: (String?) -> Unit,
  val onElementDoubleClicked: ((String) -> Unit)? = null,
  val parentMap: Map<String, String> = emptyMap(),
)

private class HierarchyTreeState {
  var searchQuery by mutableStateOf("")
  var debouncedQuery by mutableStateOf("")
  var expandedIds by mutableStateOf(setOf<String>())
  var expandedRootId by mutableStateOf<String?>(null)

  fun toggle(node: FlatTreeNode) {
    expandedIds =
      if (node.isExpanded) expandedIds - node.element.id else expandedIds + node.element.id
  }
}

@Composable
fun HierarchyTreeView(options: HierarchyTreeOptions, modifier: Modifier = Modifier) {
  val state = rememberHierarchyTreeState(options)
  val selectedPath =
    remember(options.selectedElementId, options.parentMap) {
      selectedHierarchyPath(options)
    }
  // Cache the O(n) search independently from expansion, which only rebuilds the flattened list.
  val matchingIds =
    remember(options.hierarchy, state.debouncedQuery) {
      val hierarchy = options.hierarchy
      if (hierarchy != null && state.debouncedQuery.isNotEmpty()) {
        computeMatchingIds(hierarchy, state.debouncedQuery)
      } else emptySet()
    }
  val (flatNodes, nodeIndexMap) =
    remember(options.hierarchy, state.expandedIds, state.debouncedQuery) {
      flattenedHierarchy(options.hierarchy, state, matchingIds)
    }
  val listState = rememberLazyListState()
  LaunchedEffect(options.selectedElementId, nodeIndexMap) {
    val selectedId = options.selectedElementId
    if (selectedId != null) {
      nodeIndexMap[selectedId]?.let { listState.animateScrollToItem(it) }
    }
  }
  Column(modifier = modifier.fillMaxSize()) {
    dev.jasonpearson.automobile.desktop.core.components.SearchBar(
      query = state.searchQuery,
      onQueryChange = { state.searchQuery = it },
      modifier = Modifier.fillMaxWidth().padding(8.dp),
      options = SearchBarOptions(placeholder = "Search views..."),
    )
    if (flatNodes.isEmpty()) {
      EmptyHierarchy(options.hierarchy == null)
    } else {
      HierarchyNodes(flatNodes, listState, options, selectedPath, state::toggle)
    }
  }
}

@Composable
private fun rememberHierarchyTreeState(options: HierarchyTreeOptions): HierarchyTreeState {
  val state = remember { HierarchyTreeState() }
  LaunchedEffect(state.searchQuery) {
    delay(150)
    state.debouncedQuery = state.searchQuery
  }
  LaunchedEffect(options.hierarchy) {
    val hierarchy = options.hierarchy
    if (hierarchy != null && hierarchy.id != state.expandedRootId) {
      state.expandedIds = collectIdsUpToDepth(hierarchy, maxDepth = 10)
      state.expandedRootId = hierarchy.id
    }
  }
  LaunchedEffect(options.selectedElementId, options.parentMap) {
    if (options.selectedElementId != null && options.parentMap.isNotEmpty()) {
      val path = getPathFromParentMap(options.parentMap, options.selectedElementId)
      state.expandedIds = state.expandedIds + path.dropLast(1).toSet()
    }
  }
  return state
}

private fun selectedHierarchyPath(options: HierarchyTreeOptions): Set<String> =
  if (options.selectedElementId != null && options.parentMap.isNotEmpty()) {
    getPathFromParentMap(options.parentMap, options.selectedElementId).toSet()
  } else emptySet()

private fun flattenedHierarchy(
  hierarchy: UIElementInfo?,
  state: HierarchyTreeState,
  matchingIds: Set<String>,
): Pair<List<FlatTreeNode>, Map<String, Int>> {
  if (hierarchy == null) return emptyList<FlatTreeNode>() to emptyMap()
  val nodes = flattenTree(hierarchy, state.expandedIds, state.debouncedQuery, matchingIds)
  return nodes to nodes.withIndex().associate { (i, node) -> node.element.id to i }
}

@Composable
private fun EmptyHierarchy(noHierarchy: Boolean) {
  Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Text(
      if (noHierarchy) "No hierarchy loaded" else "No matching elements",
      color = SharedTheme.globalColors.text.normal.copy(alpha = 0.5f),
      fontSize = 12.sp,
    )
  }
}

@Composable
private fun HierarchyNodes(
  flatNodes: List<FlatTreeNode>,
  listState: LazyListState,
  options: HierarchyTreeOptions,
  selectedPath: Set<String>,
  onToggleExpand: (FlatTreeNode) -> Unit,
) {
  val horizontalScrollState = rememberScrollState()
  val maxDepth = flatNodes.maxOfOrNull { it.depth } ?: 0
  val estimatedContentWidth = ((maxDepth + 1) * 16 + 400).dp
  Box(modifier = Modifier.fillMaxSize().horizontalScroll(horizontalScrollState)) {
    LazyColumn(state = listState, modifier = Modifier.widthIn(min = estimatedContentWidth)) {
      itemsIndexed(flatNodes, key = { index, node -> "${index}_${node.element.id}" }) { _, node ->
        TreeNodeRow(
          node,
          TreeNodeOptions(
            isSelected = node.element.id == options.selectedElementId,
            isHovered = node.element.id == options.hoveredElementId,
            isInSelectedPath = node.element.id in selectedPath,
            onToggleExpand = { onToggleExpand(node) },
            onSelect = { options.onElementSelected(node.element.id) },
            onDoubleClick = { options.onElementDoubleClicked?.invoke(node.element.id) },
            onHoverChange = { hovered ->
              options.onElementHovered(if (hovered) node.element.id else null)
            },
          ),
        )
      }
    }
  }
}

/**
 * Flattens the tree hierarchy for virtualized rendering. Filters by search query and handles
 * expanded state. [matchingIds] is pre-computed via [computeMatchingIds] for O(1) membership
 * checks.
 */
private fun flattenTree(
  root: UIElementInfo,
  expandedIds: Set<String>,
  searchQuery: String,
  matchingIds: Set<String>,
): List<FlatTreeNode> {
  val result = mutableListOf<FlatTreeNode>()

  fun traverse(element: UIElementInfo, depth: Int) {
    val isIncluded = searchQuery.isEmpty() || element.id in matchingIds

    if (isIncluded) {
      val hasMatchingChild =
        searchQuery.isNotEmpty() && element.children.any { it.id in matchingIds }
      val isExpanded = element.id in expandedIds || (searchQuery.isNotEmpty() && hasMatchingChild)

      result.add(
        FlatTreeNode(
          element = element,
          depth = depth,
          isExpanded = isExpanded,
          hasChildren = element.children.isNotEmpty(),
        ),
      )

      if (isExpanded) {
        element.children.forEach { child ->
          traverse(child, depth + 1)
        }
      }
    }
  }

  traverse(root, 0)
  return result
}

/**
 * Pre-compute the set of element IDs that match the search query or have matching descendants.
 * Single O(n) pass — each node is visited exactly once.
 */
fun computeMatchingIds(root: UIElementInfo, searchQuery: String): Set<String> {
  if (searchQuery.isEmpty()) return emptySet()
  val ids = mutableSetOf<String>()
  fun traverse(element: UIElementInfo): Boolean {
    val selfMatches = matchesSearch(element, searchQuery)
    var childMatches = false
    for (child in element.children) {
      if (traverse(child)) childMatches = true
    }
    if (selfMatches || childMatches) {
      ids.add(element.id)
      return true
    }
    return false
  }
  traverse(root)
  return ids
}

private fun matchesSearch(element: UIElementInfo, searchQuery: String): Boolean {
  val query = searchQuery.lowercase()
  return element.className.lowercase().contains(query) ||
    element.resourceId?.lowercase()?.contains(query) == true ||
    element.text?.lowercase()?.contains(query) == true ||
    element.contentDescription?.lowercase()?.contains(query) == true
}

/** Collects all element IDs up to a given depth for auto-expansion. */
private fun collectIdsUpToDepth(root: UIElementInfo, maxDepth: Int): Set<String> {
  val result = mutableSetOf<String>()

  fun traverse(element: UIElementInfo, depth: Int) {
    if (depth < maxDepth && element.children.isNotEmpty()) {
      result.add(element.id)
      element.children.forEach { child ->
        traverse(child, depth + 1)
      }
    }
  }

  traverse(root, 0)
  return result
}
