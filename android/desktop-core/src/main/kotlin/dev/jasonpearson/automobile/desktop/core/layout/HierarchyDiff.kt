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

internal const val PATH_SEPARATOR = "/"

/**
 * How [diffHierarchies] forms a node's structural key segment.
 * - [ClassName]: the raw platform-specific `className` (plus `resourceId`). The honest identity for
 *   a **same-platform** diff, where classes and ids line up.
 * - [StructuralRole]: the cross-platform [structuralRole] of the class, with `resourceId` dropped
 *   (ids are platform-specific and never match across Android↔iOS). Lets an Android and an iOS
 *   rendering of the same screen pair by role + tree position and produce a meaningful diff instead
 *   of two disjoint OnlyIn trees (issue #4872).
 */
enum class DiffKeyMode {
  ClassName,
  StructuralRole,
}

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
 *
 * [keyMode] selects how each key segment is formed. The default [DiffKeyMode.ClassName] keeps the
 * raw platform-specific identity for a same-platform diff; [DiffKeyMode.StructuralRole] keys on the
 * cross-platform [structuralRole] instead so an Android↔iOS pair diffs meaningfully. The mode only
 * changes the *segment* (className/resourceId → role); every other property above — window
 * alignment, pre-order determinism, the attribute-only Changed test, and the A/B symmetry — is
 * mode-independent because it is threaded identically through both the diff index and the
 * window-alignment signatures.
 */
fun diffHierarchies(
  a: UIElementInfo,
  b: UIElementInfo,
  keyMode: DiffKeyMode = DiffKeyMode.ClassName,
): HierarchyDiff {
  val windowsA = windowsOf(a)
  val windowsB = windowsOf(b)
  val (slotsA, slotsB) = alignWindowSlots(windowsA, windowsB, keyMode)
  val (mapA, mapB) =
    if (keyMode == DiffKeyMode.StructuralRole) {
      indexAlignedWindows(windowsA, slotsA, windowsB, slotsB, keyMode)
    } else {
      indexWindows(windowsA, slotsA, keyMode) to indexWindows(windowsB, slotsB, keyMode)
    }
  val entries = ArrayList<HierarchyDiffEntry>(mapA.size + mapB.size)
  for ((key, nodeA) in mapA) {
    val nodeB = mapB[key]
    entries.add(HierarchyDiffEntry(key, classifyMatched(nodeA, nodeB, keyMode), nodeA, nodeB))
  }
  for ((key, nodeB) in mapB) {
    if (!mapA.containsKey(key)) {
      entries.add(HierarchyDiffEntry(key, NodeDiffStatus.OnlyInB, null, nodeB))
    }
  }
  return HierarchyDiff(entries)
}

/** Classify a node from A against its same-key counterpart in B (null when absent from B). */
internal fun classifyMatched(
  nodeA: UIElementInfo,
  nodeB: UIElementInfo?,
  keyMode: DiffKeyMode,
): NodeDiffStatus =
  when {
    nodeB == null -> NodeDiffStatus.OnlyInA
    nodeAttributesDiffer(nodeA, nodeB, keyMode) -> NodeDiffStatus.Changed
    else -> NodeDiffStatus.Equal
  }

/**
 * The top-level windows of a frame. The synthetic multi-window wrapper (see
 * [MULTI_WINDOW_ROOT_CLASS_NAME], issue #4874) is unwrapped to its window children; a plain
 * single-window frame is its own only window. This normalization is what lets a single-window frame
 * match the corresponding window of a wrapped multi-window frame (see [alignWindowSlots]).
 */
internal fun windowsOf(root: UIElementInfo): List<UIElementInfo> =
  if (root.className == MULTI_WINDOW_ROOT_CLASS_NAME) root.children else listOf(root)

/**
 * Build a stable key -> node map in pre-order for a frame's [windows], keying each window's subtree
 * at its assigned **window slot** (from [alignWindowSlots]) as the top-level sibling index. Keys
 * are unique within one tree by construction (the per-level sibling index disambiguates siblings,
 * and the ancestor chain disambiguates subtrees).
 *
 * The synthetic multi-window wrapper is **transparent** to the diff: each window is indexed as if
 * it were a top-level root. Without this, a frame with an extra window (e.g. an IME) is wrapped
 * while the other side is not, so every node's key gains a `AutoMobile.MultiWindowRoot/…` prefix on
 * only one side and nothing matches — the whole app reports as OnlyInA/OnlyInB instead of isolating
 * the extra window.
 *
 * The window slot (not the raw window index) is the top-level sibling index, so windows the aligner
 * paired across the two frames share a key namespace even when a window was inserted or removed
 * *before* them and their raw indexes shifted.
 */
internal fun indexWindows(
  windows: List<UIElementInfo>,
  slots: IntArray,
  keyMode: DiffKeyMode,
): LinkedHashMap<String, UIElementInfo> {
  val map = LinkedHashMap<String, UIElementInfo>()
  windows.forEachIndexed { index, window ->
    addSubtree(
      dev.jasonpearson.automobile.desktop.core.layout.HierarchySubtreeIndex(
        map,
        window,
        parentKey = "",
        siblingIndex = slots[index],
        keyMode = keyMode,
        parentRole = null,
      ),
    )
  }
  return map
}

internal fun addSubtree(options: HierarchySubtreeIndex) {
  with(options) {
    val role = roleFor(node, keyMode, parentRole)
    val key = pathKey(parentKey, node, siblingIndex, keyMode, role)
    map[key] = node
    node.children.forEachIndexed { index, child ->
      addSubtree(
        dev.jasonpearson.automobile.desktop.core.layout.HierarchySubtreeIndex(
          map,
          child,
          key,
          index,
          keyMode,
          role,
        ),
      )
    }
  }
}
