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
  val windowsA = windowsOf(a)
  val windowsB = windowsOf(b)
  val (slotsA, slotsB) = alignWindowSlots(windowsA, windowsB)
  val mapA = indexWindows(windowsA, slotsA)
  val mapB = indexWindows(windowsB, slotsB)
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
 * The top-level windows of a frame. The synthetic multi-window wrapper (see
 * [MULTI_WINDOW_ROOT_CLASS_NAME], issue #4874) is unwrapped to its window children; a plain
 * single-window frame is its own only window. This normalization is what lets a single-window frame
 * match the corresponding window of a wrapped multi-window frame (see [alignWindowSlots]).
 */
private fun windowsOf(root: UIElementInfo): List<UIElementInfo> =
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
private fun indexWindows(
  windows: List<UIElementInfo>,
  slots: IntArray,
): LinkedHashMap<String, UIElementInfo> {
  val map = LinkedHashMap<String, UIElementInfo>()
  windows.forEachIndexed { index, window ->
    addSubtree(map, window, parentKey = "", siblingIndex = slots[index])
  }
  return map
}

/**
 * Assign each window of frame A and frame B a **window slot** — the top-level sibling index its
 * subtree is keyed at — such that windows that are the "same window" across the two frames share a
 * slot and thus pair in the diff, while inserted/removed windows get their own slots and surface as
 * OnlyIn.
 *
 * Windows carry no stable cross-side identity at this layer — bounds are excluded by design
 * (resolution differs) and the wire's only per-window id is a content hash
 * (`src/features/observe/android/StableNodeIdentity.ts`), not a stable window handle. So windows
 * are matched by **subtree similarity** with an **order-preserving alignment** (a Needleman–Wunsch
 * global alignment over the window sequences, scoring a pairing by the Jaccard overlap of the two
 * subtrees' structural path keys, gaps free). Order preservation reflects z-order: an inserted or
 * removed window shifts the survivors' indexes but not their relative order.
 *
 * This subsumes the previous positional pairing: for equal-length frames the diagonal (pair window
 * _i_ with window _i_) alignment maximizes the score and is preferred on ties, so parallel window
 * stacks and single-vs-single frames pair exactly as before. Only when a strictly-better alignment
 * exists — i.e. a window was inserted/removed before another — are gaps introduced, pairing the
 * surviving windows so just the genuinely-extra window surfaces (issue #5533).
 *
 * Alignment columns are numbered left-to-right, so a paired column gives both its windows the same
 * slot and a gap column gives its one window a slot of its own. This numbering is a pure function
 * of the (order-preserving, hence non-crossing) alignment, so `diffHierarchies(a, b)` and
 * `diffHierarchies(b, a)` assign every window the same slot — preserving the A/B symmetry contract
 * of [diffHierarchies].
 */
private fun alignWindowSlots(
  windowsA: List<UIElementInfo>,
  windowsB: List<UIElementInfo>,
): Pair<IntArray, IntArray> {
  val n = windowsA.size
  val m = windowsB.size
  val slotsA = IntArray(n)
  val slotsB = IntArray(m)
  // Common fast paths: a single window per side always pairs at slot 0 (identical to the previous
  // positional behavior, including for zero-overlap cross-platform frames).
  if (n <= 1 && m <= 1) {
    return slotsA to slotsB
  }

  val signaturesA = windowsA.map { signatureKeys(it) }
  val signaturesB = windowsB.map { signatureKeys(it) }
  // A canonical, side-independent ordering key per window (its sorted signature). Used only to
  // break a skipA-vs-skipB tie deterministically by window *content* rather than by side, so the
  // choice is transposition-invariant (see the backtrack below).
  val canonicalA = signaturesA.map { canonicalSignature(it) }
  val canonicalB = signaturesB.map { canonicalSignature(it) }

  // Needleman–Wunsch: score[i][j] is the best alignment score of the first i A-windows against the
  // first j B-windows. A diagonal step pairs the two windows (adds their similarity); an up/left
  // step leaves a window unpaired (a gap, scored 0).
  val score = Array(n + 1) { DoubleArray(m + 1) }
  for (i in 1..n) {
    for (j in 1..m) {
      val diagonal = score[i - 1][j - 1] + jaccard(signaturesA[i - 1], signaturesB[j - 1])
      val skipA = score[i - 1][j]
      val skipB = score[i][j - 1]
      score[i][j] = maxOf(diagonal, skipA, skipB)
    }
  }

  // Backtrack to the alignment columns, then number them left-to-right. Ties prefer the diagonal
  // (keeps positional pairing). When a gap must be chosen and skipA and skipB score equally, break
  // the tie by window *content* — skip the canonically-smaller window — not by A/B side. A fixed
  // side preference (always skipA) is not transposition-invariant: two windows that reverse
  // z-order (similarities `[[0,1],[1,0]]`) then pair differently under swap, breaking the symmetry
  // contract of [diffHierarchies]. Choosing by content skips the *same* window either way.
  val columnsA = ArrayList<Int>()
  val columnsB = ArrayList<Int>()
  var i = n
  var j = m
  while (i > 0 || j > 0) {
    val diagonal =
      if (i > 0 && j > 0) score[i - 1][j - 1] + jaccard(signaturesA[i - 1], signaturesB[j - 1])
      else Double.NEGATIVE_INFINITY
    val skipA = if (i > 0) score[i - 1][j] else Double.NEGATIVE_INFINITY
    val skipB = if (j > 0) score[i][j - 1] else Double.NEGATIVE_INFINITY
    val takeSkipA =
      when {
        j == 0 -> true
        i == 0 -> false
        skipA > skipB -> true
        skipB > skipA -> false
        // Equal scores: skip the canonically-smaller window (ties → skipA); side-independent.
        else -> canonicalA[i - 1] <= canonicalB[j - 1]
      }
    when {
      i > 0 && j > 0 && diagonal >= skipA && diagonal >= skipB -> {
        columnsA.add(i - 1)
        columnsB.add(j - 1)
        i--
        j--
      }
      takeSkipA -> {
        columnsA.add(i - 1)
        columnsB.add(-1)
        i--
      }
      else -> {
        columnsA.add(-1)
        columnsB.add(j - 1)
        j--
      }
    }
  }
  // Backtracking yielded columns right-to-left; number them so the leftmost column is slot 0.
  var slot = 0
  for (column in columnsA.indices.reversed()) {
    val aIndex = columnsA[column]
    val bIndex = columnsB[column]
    if (aIndex >= 0) slotsA[aIndex] = slot
    if (bIndex >= 0) slotsB[bIndex] = slot
    slot++
  }
  return slotsA to slotsB
}

/**
 * The set of structural path keys of a window's subtree, computed independently of the window's
 * slot (the window root sits at sibling index 0). Two windows with identical structure produce
 * identical key sets, so [jaccard] overlap measures subtree similarity for [alignWindowSlots].
 */
private fun signatureKeys(window: UIElementInfo): Set<String> {
  val map = LinkedHashMap<String, UIElementInfo>()
  addSubtree(map, window, parentKey = "", siblingIndex = 0)
  return map.keys
}

/**
 * A canonical, order-independent string for a window's structural key set: its keys sorted and
 * joined. Two windows compare equal here iff they have the same set of structural keys, so it is a
 * side-independent total order for the transposition-invariant tie-break in [alignWindowSlots].
 */
private fun canonicalSignature(signature: Set<String>): String =
  signature.sorted().joinToString(" ")

/** Jaccard overlap |a ∩ b| / |a ∪ b| of two structural key sets; 0 when both are empty. */
private fun jaccard(a: Set<String>, b: Set<String>): Double {
  if (a.isEmpty() && b.isEmpty()) return 0.0
  var intersection = 0
  for (key in a) {
    if (key in b) intersection++
  }
  val union = a.size + b.size - intersection
  return if (union == 0) 0.0 else intersection.toDouble() / union.toDouble()
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
