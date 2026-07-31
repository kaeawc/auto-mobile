package dev.jasonpearson.automobile.desktop.core.layout

/**
 * How a node in one hierarchy relates to the matching node (by structural key) in the other.
 * - [OnlyInA] / [OnlyInB]: the key exists in exactly one tree.
 * - [Changed]: the key exists in both, but a compared semantic attribute differs.
 * - [Equal]: the key exists in both and all compared attributes match.
 */
enum class NodeDiffStatus {
  OnlyInA,
  OnlyInB,
  Changed,
  Equal,
}

/**
 * One node's classification in a two-hierarchy diff. [key] is the stable structural path key (see
 * [diffHierarchies]); [a] and [b] are the matched nodes, one of which is null for
 * [NodeDiffStatus. OnlyInA]/[NodeDiffStatus.OnlyInB].
 */
data class HierarchyDiffEntry(
  val key: String,
  val status: NodeDiffStatus,
  val a: UIElementInfo?,
  val b: UIElementInfo?,
)

/**
 * The result of diffing two view hierarchies. [entries] are deterministic: A's nodes in pre-order,
 * then B-only nodes in B's pre-order. Convenience counters summarise the classification.
 */
data class HierarchyDiff(val entries: List<HierarchyDiffEntry>) {
  val onlyInA: Int
    get() = entries.count { it.status == NodeDiffStatus.OnlyInA }

  val onlyInB: Int
    get() = entries.count { it.status == NodeDiffStatus.OnlyInB }

  val changed: Int
    get() = entries.count { it.status == NodeDiffStatus.Changed }

  val equal: Int
    get() = entries.count { it.status == NodeDiffStatus.Equal }

  val hasDifferences: Boolean
    get() = onlyInA > 0 || onlyInB > 0 || changed > 0
}

private const val PATH_SEPARATOR = "/"

/**
 * Diff two view hierarchies into a flat, deterministic classification.
 *
 * Node identity is a **structural path key**: each node contributes the segment
 * `className:resourceId#siblingIndex`, and a node's key is the `/`-joined chain of its ancestors'
 * segments plus its own. Because every segment carries the sibling index, keys are unique within a
 * tree, so matched keys pair the node at the same tree position across the two devices.
 *
 * Consequences of this first-cut identity (richer heuristics are deferred):
 * - **Bounds are intentionally excluded** from the [NodeDiffStatus.Changed] test. Two devices
 *   usually differ in resolution, so every node's geometry differs; comparing bounds would flag the
 *   whole tree as changed and drown out the meaningful diffs. Only semantic attributes (text,
 *   content-description, and the boolean state flags) are compared.
 * - **Reordering is positional.** Swapping two siblings changes their sibling indexes, so the moved
 *   nodes surface as `OnlyInA` + `OnlyInB` at the affected positions rather than as a move.
 *
 * The result is deterministic (stable pre-order) and symmetric in classification: `diffHierarchies(
 * a, b)` and `diffHierarchies(b, a)` agree once A/B roles are swapped (an `OnlyInA` key in one is
 * exactly an `OnlyInB` key in the other; `Changed`/`Equal` key sets are identical).
 */
fun diffHierarchies(a: UIElementInfo, b: UIElementInfo): HierarchyDiff {
  val mapA = indexByPathKey(a)
  val mapB = indexByPathKey(b)
  val entries = ArrayList<HierarchyDiffEntry>(mapA.size + mapB.size)
  for ((key, nodeA) in mapA) {
    val nodeB = mapB[key]
    entries.add(HierarchyDiffEntry(key, classifyMatched(nodeA, nodeB), nodeA, nodeB))
  }
  for ((key, nodeB) in mapB) {
    if (!mapA.containsKey(key)) {
      entries.add(HierarchyDiffEntry(key, NodeDiffStatus.OnlyInB, null, nodeB))
    }
  }
  return HierarchyDiff(entries)
}

/** Classify a node from A against its same-key counterpart in B (null when absent from B). */
private fun classifyMatched(nodeA: UIElementInfo, nodeB: UIElementInfo?): NodeDiffStatus =
  when {
    nodeB == null -> NodeDiffStatus.OnlyInA
    nodeAttributesDiffer(nodeA, nodeB) -> NodeDiffStatus.Changed
    else -> NodeDiffStatus.Equal
  }

/**
 * Build a stable key -> node map in pre-order. Keys are unique within one tree by construction (the
 * per-level sibling index disambiguates siblings, and the ancestor chain disambiguates subtrees).
 */
private fun indexByPathKey(root: UIElementInfo): LinkedHashMap<String, UIElementInfo> {
  val map = LinkedHashMap<String, UIElementInfo>()
  addSubtree(map, root, parentKey = "", siblingIndex = 0)
  return map
}

private fun addSubtree(
  map: LinkedHashMap<String, UIElementInfo>,
  node: UIElementInfo,
  parentKey: String,
  siblingIndex: Int,
) {
  val key = pathKey(parentKey, node, siblingIndex)
  map[key] = node
  node.children.forEachIndexed { index, child -> addSubtree(map, child, key, index) }
}

private fun pathKey(parentKey: String, node: UIElementInfo, siblingIndex: Int): String {
  val segment = "${node.className}:${node.resourceId ?: ""}#$siblingIndex"
  return if (parentKey.isEmpty()) segment else "$parentKey$PATH_SEPARATOR$segment"
}

/**
 * Whether two same-key nodes differ in a compared semantic attribute. Bounds and children are
 * deliberately excluded (see [diffHierarchies]); className and resourceId are already equal because
 * they are part of the key.
 */
private fun nodeAttributesDiffer(a: UIElementInfo, b: UIElementInfo): Boolean =
  a.text != b.text ||
    a.contentDescription != b.contentDescription ||
    a.isClickable != b.isClickable ||
    a.isEnabled != b.isEnabled ||
    a.isFocused != b.isFocused ||
    a.isSelected != b.isSelected ||
    a.isScrollable != b.isScrollable ||
    a.isCheckable != b.isCheckable ||
    a.isChecked != b.isChecked
