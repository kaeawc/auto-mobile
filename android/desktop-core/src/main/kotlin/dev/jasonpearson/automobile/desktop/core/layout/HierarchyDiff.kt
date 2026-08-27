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
private fun classifyMatched(
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
  keyMode: DiffKeyMode,
): LinkedHashMap<String, UIElementInfo> {
  val map = LinkedHashMap<String, UIElementInfo>()
  windows.forEachIndexed { index, window ->
    addSubtree(
      map,
      window,
      parentKey = "",
      siblingIndex = slots[index],
      keyMode = keyMode,
      parentRole = null,
    )
  }
  return map
}

/** Index role-mode trees with order-preserving, cross-side child slots. */
private fun indexAlignedWindows(
  windowsA: List<UIElementInfo>,
  slotsA: IntArray,
  windowsB: List<UIElementInfo>,
  slotsB: IntArray,
  keyMode: DiffKeyMode,
): Pair<LinkedHashMap<String, UIElementInfo>, LinkedHashMap<String, UIElementInfo>> {
  val mapA = LinkedHashMap<String, UIElementInfo>()
  val mapB = LinkedHashMap<String, UIElementInfo>()
  addAlignedChildren(mapA, mapB, windowsA, slotsA, windowsB, slotsB, "", null, null, keyMode)
  return mapA to mapB
}

private fun addAlignedChildren(
  mapA: LinkedHashMap<String, UIElementInfo>,
  mapB: LinkedHashMap<String, UIElementInfo>,
  childrenA: List<UIElementInfo>,
  slotsA: IntArray,
  childrenB: List<UIElementInfo>,
  slotsB: IntArray,
  parentKey: String,
  parentRoleA: StructuralRole?,
  parentRoleB: StructuralRole?,
  keyMode: DiffKeyMode,
) {
  val bySlotA = childrenA.indices.associateBy { slotsA[it] }
  val bySlotB = childrenB.indices.associateBy { slotsB[it] }
  (bySlotA.keys + bySlotB.keys).sorted().forEach { slot ->
    val nodeA = bySlotA[slot]?.let(childrenA::get)
    val nodeB = bySlotB[slot]?.let(childrenB::get)
    val roleA = nodeA?.let { roleFor(it, keyMode, parentRoleA) }
    val roleB = nodeB?.let { roleFor(it, keyMode, parentRoleB) }
    nodeA?.let { mapA[pathKey(parentKey, it, slot, keyMode, roleA)] = it }
    nodeB?.let { mapB[pathKey(parentKey, it, slot, keyMode, roleB)] = it }
    val key =
      nodeA?.let { pathKey(parentKey, it, slot, keyMode, roleA) }
        ?: nodeB?.let { pathKey(parentKey, it, slot, keyMode, roleB) }
        ?: return@forEach
    val (childSlotsA, childSlotsB) =
      alignChildSlots(nodeA?.children.orEmpty(), nodeB?.children.orEmpty(), roleA, roleB)
    addAlignedChildren(
      mapA,
      mapB,
      nodeA?.children.orEmpty(),
      childSlotsA,
      nodeB?.children.orEmpty(),
      childSlotsB,
      key,
      roleA,
      roleB,
      keyMode,
    )
  }
}

/** Needleman-Wunsch alignment that only pairs siblings with the same structural role. */
private fun alignChildSlots(
  childrenA: List<UIElementInfo>,
  childrenB: List<UIElementInfo>,
  parentRoleA: StructuralRole?,
  parentRoleB: StructuralRole?,
): Pair<IntArray, IntArray> {
  val slotsA = IntArray(childrenA.size)
  val slotsB = IntArray(childrenB.size)
  fun similarity(a: UIElementInfo, b: UIElementInfo): Double {
    if (structuralRoleOf(a, parentRoleA) != structuralRoleOf(b, parentRoleB)) {
      return Double.NEGATIVE_INFINITY
    }
    return if (accessibleName(a) == accessibleName(b)) 2.0 else 1.0
  }
  val score = Array(childrenA.size + 1) { DoubleArray(childrenB.size + 1) }
  for (i in 1..childrenA.size) for (j in 1..childrenB.size) {
    score[i][j] =
      maxOf(
        score[i - 1][j - 1] + similarity(childrenA[i - 1], childrenB[j - 1]),
        score[i - 1][j],
        score[i][j - 1],
      )
  }
  val columnsA = ArrayList<Int>()
  val columnsB = ArrayList<Int>()
  var i = childrenA.size
  var j = childrenB.size
  while (i > 0 || j > 0) {
    val diagonal =
      if (i > 0 && j > 0) score[i - 1][j - 1] + similarity(childrenA[i - 1], childrenB[j - 1])
      else Double.NEGATIVE_INFINITY
    when {
      i > 0 && j > 0 && diagonal >= score[i - 1][j] && diagonal >= score[i][j - 1] -> {
        columnsA.add(--i)
        columnsB.add(--j)
      }
      i > 0 && (j == 0 || score[i - 1][j] >= score[i][j - 1]) -> {
        columnsA.add(--i)
        columnsB.add(-1)
      }
      else -> {
        columnsA.add(-1)
        columnsB.add(--j)
      }
    }
  }
  var slot = 0
  for (column in columnsA.indices.reversed()) {
    columnsA[column].takeIf { it >= 0 }?.let { slotsA[it] = slot }
    columnsB[column].takeIf { it >= 0 }?.let { slotsB[it] = slot }
    slot++
  }
  return slotsA to slotsB
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
  keyMode: DiffKeyMode,
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

  val signaturesA = windowsA.map { signatureKeys(it, keyMode) }
  val signaturesB = windowsB.map { signatureKeys(it, keyMode) }
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
 * The semantic-aware signature key set of a window's subtree, computed independently of the
 * window's slot (the window root sits at sibling index 0). Two windows that are fully equal
 * (structure **and** compared attributes) produce identical key sets, so [jaccard] overlap measures
 * subtree similarity for [alignWindowSlots]. See [collectSignatureKeys].
 */
private fun signatureKeys(window: UIElementInfo, keyMode: DiffKeyMode): Set<String> {
  val keys = LinkedHashSet<String>()
  collectSignatureKeys(
    keys,
    window,
    parentKey = "",
    siblingIndex = 0,
    keyMode = keyMode,
    parentRole = null,
  )
  return keys
}

/**
 * Accumulate a window's subtree into semantic-aware signature keys. Each node contributes its
 * **structural** path key (via [pathKey], so the ancestor chain and sibling indexes match the diff)
 * plus a digest of the same attributes [nodeAttributesDiffer] compares. Descendants nest under the
 * structural parent key, so a semantic difference on one node changes only that node's key.
 *
 * Folding semantics in is what lets [alignWindowSlots] pair the *right* window when a side holds
 * structurally-identical duplicates that differ only in content: a fully-equal window then scores
 * Jaccard 1 while a same-shape-but-changed one scores lower, so the aligner prefers the true match
 * instead of arbitrarily pairing a trailing duplicate.
 */
private fun collectSignatureKeys(
  keys: MutableSet<String>,
  node: UIElementInfo,
  parentKey: String,
  siblingIndex: Int,
  keyMode: DiffKeyMode,
  parentRole: StructuralRole?,
) {
  val role = roleFor(node, keyMode, parentRole)
  val structural = pathKey(parentKey, node, siblingIndex, keyMode, role)
  keys.add("$structural::${semanticDigest(node, keyMode)}")
  node.children.forEachIndexed { index, child ->
    collectSignatureKeys(keys, child, structural, index, keyMode, role)
  }
}

/**
 * The compared semantic attributes of a node, joined — the [nodeAttributesDiffer] surface, and it
 * must track that surface per [keyMode]. Same-platform keeps `text` and `contentDescription` as two
 * fields; cross-platform collapses them to the single normalized [accessibleName] so the alignment
 * signatures agree with the role-mode Changed test.
 */
private fun semanticDigest(node: UIElementInfo, keyMode: DiffKeyMode): String {
  val label =
    when (keyMode) {
      DiffKeyMode.ClassName -> "${node.text ?: ""}|${node.contentDescription ?: ""}"
      DiffKeyMode.StructuralRole -> accessibleName(node) ?: ""
    }
  return listOf(
      label,
      node.isClickable,
      node.isEnabled,
      node.isFocused,
      node.isSelected,
      node.isScrollable,
      node.isCheckable,
      node.isChecked,
    )
    .joinToString("|")
}

/**
 * A canonical, order-independent string for a window's signature key set: its keys sorted and
 * joined. Two windows compare equal here iff they have the same set of signature keys, so it is a
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
  keyMode: DiffKeyMode,
  parentRole: StructuralRole?,
) {
  val role = roleFor(node, keyMode, parentRole)
  val key = pathKey(parentKey, node, siblingIndex, keyMode, role)
  map[key] = node
  node.children.forEachIndexed { index, child ->
    addSubtree(map, child, key, index, keyMode, role)
  }
}

/**
 * The resolved [StructuralRole] for a node in role mode, threaded to children as their parent role;
 * null in class-name mode where roles are unused. Computed once per node so [pathKey] and the
 * recursion share the value (and the [structuralRoleOf] parent-context inference).
 */
private fun roleFor(
  node: UIElementInfo,
  keyMode: DiffKeyMode,
  parentRole: StructuralRole?,
): StructuralRole? =
  if (keyMode == DiffKeyMode.StructuralRole) structuralRoleOf(node, parentRole) else null

private fun pathKey(
  parentKey: String,
  node: UIElementInfo,
  siblingIndex: Int,
  keyMode: DiffKeyMode,
  role: StructuralRole?,
): String {
  val segment =
    when (keyMode) {
      DiffKeyMode.ClassName -> "${node.className}:${node.resourceId ?: ""}#$siblingIndex"
      // Role mode drops the platform-specific resourceId: it never matches across Android↔iOS, so
      // keeping it would defeat the whole point of role keying. [role] is the pre-resolved
      // [roleFor] value (non-null in this mode).
      DiffKeyMode.StructuralRole -> "${role}#$siblingIndex"
    }
  return if (parentKey.isEmpty()) segment else "$parentKey$PATH_SEPARATOR$segment"
}

/**
 * The cross-platform [StructuralRole] of a full node, given its [parentRole] (the resolved role of
 * its parent, or null at a window root). Starts from the class-name mapping, then applies the
 * semantic and positional signals a class name alone cannot carry:
 * - A checkable node is promoted to [StructuralRole.Checkbox] unless its class already keyed it to
 *   the sibling checkable role [StructuralRole.Switch]. The live iOS runner reports a checkbox as
 *   the bare `UIView` class (`ElementLocator.mapElementType` has no `.checkBox` case) while still
 *   setting `isCheckable`, so an iOS checkbox arrives as a generic Container; Android's
 *   `CheckedTextView` instead keys as [StructuralRole.Text] by class (it contains the `TextView`
 *   substring) yet is a standard checkable control. Promoting on `isCheckable` regardless of the
 *   class-derived role — not only the generic ones — pairs both against Android's `CheckBox`
 *   instead of leaving them as OnlyIn. `Switch` is exempt so a `UISwitch`/`SwitchCompat`/
 *   `ToggleButton` (also checkable) keeps its own distinct role (issue #4872 review).
 * - A generic node whose [parentRole] is [StructuralRole.List] is promoted to
 *   [StructuralRole.ListItem]: it is the list's row wrapper. iOS emits a row as a `UITableViewCell
 *   -> ListItem` by class, but an Android row is an ordinary `LinearLayout`/`ViewGroup ->
 *   Container` whose collection-item metadata `HierarchyParser` drops, so inferring `ListItem` from
 *   the `List` parent is what pairs the two rows (and thus their descendants) instead of leaving
 *   every row as OnlyIn (issue #4872 review).
 * - A non-interactive generic node that carries an accessible name is promoted to
 *   [StructuralRole.Text]. Android's `ViewHierarchyExtractor` blanks `android.widget.TextView` to a
 *   class-less node (it is in `GENERIC_CLASS_NAMES`), which `HierarchyParser` then defaults to
 *   `android.view.View` — so an ordinary Android label reaches here as a generic Container and
 *   would never pair with the iOS runner's `UILabel -> Text`, leaving ubiquitous labels and their
 *   whole subtrees as OnlyIn. The promotion recovers the label the producer erased. It is gated on
 *   non-empty accessible name and on the node being neither clickable nor scrollable, so a genuine
 *   interactive control or scroll container that merely happens to carry a label is left in its
 *   structural role (issue #4872 review).
 * - A generic scrollable node is promoted to [StructuralRole.ScrollView]. Android's extractor also
 *   clears `android.widget.ScrollView`, but retains `isScrollable`; without this recovery it
 *   remains a Container and cannot pair with iOS's `UIScrollView -> ScrollView` role.
 */
private fun structuralRoleOf(node: UIElementInfo, parentRole: StructuralRole?): StructuralRole {
  val byClass = structuralRole(node.className)
  // Checkable controls key as Checkbox even when the class name mapped them elsewhere (e.g.
  // CheckedTextView -> Text), so a checkable control pairs across platforms. Switch is left alone:
  // it is a distinct checkable role that must not collapse into Checkbox.
  if (node.isCheckable && byClass != StructuralRole.Switch) return StructuralRole.Checkbox
  val isGeneric = byClass == StructuralRole.Container || byClass == StructuralRole.Other
  if (!isGeneric) return byClass
  if (parentRole == StructuralRole.List) return StructuralRole.ListItem
  if (node.isScrollable) return StructuralRole.ScrollView
  val hasAccessibleName = !accessibleName(node).isNullOrEmpty()
  if (hasAccessibleName && !node.isClickable && !node.isScrollable) return StructuralRole.Text
  return byClass
}

/**
 * Whether two same-key nodes differ in a compared semantic attribute. Bounds and children are
 * deliberately excluded (see [diffHierarchies]); className and resourceId are already equal because
 * they are part of the key.
 *
 * [keyMode] governs the label comparison. A same-platform diff ([DiffKeyMode.ClassName]) compares
 * `text` and `contentDescription` field-by-field, the honest identity where both platforms fill the
 * same fields. A cross-platform diff ([DiffKeyMode.StructuralRole]) compares a single normalized
 * [accessibleName] instead: Android puts an icon control's label in `content-desc` and a visible
 * label in `text`, whereas iOS puts every accessibility label in `text` and leaves `content-desc`
 * null — so comparing the fields separately reports equivalent controls (an Android
 * `content-desc="Add"` vs an iOS `text="Add"`) as Changed. The boolean state flags are compared
 * identically in both modes (issue #4872 review).
 */
private fun nodeAttributesDiffer(
  a: UIElementInfo,
  b: UIElementInfo,
  keyMode: DiffKeyMode,
): Boolean {
  val labelsDiffer =
    when (keyMode) {
      DiffKeyMode.ClassName -> a.text != b.text || a.contentDescription != b.contentDescription
      DiffKeyMode.StructuralRole -> accessibleName(a) != accessibleName(b)
    }
  return labelsDiffer ||
    a.isClickable != b.isClickable ||
    a.isEnabled != b.isEnabled ||
    a.isFocused != b.isFocused ||
    a.isSelected != b.isSelected ||
    a.isScrollable != b.isScrollable ||
    a.isCheckable != b.isCheckable ||
    a.isChecked != b.isChecked
}

/**
 * The cross-platform accessible name of a node. Android's explicit content description is its
 * accessibility label even when visible text is also present; iOS serializes that label in `text`
 * and leaves `contentDescription` empty. Prefer the former when available, then fall back to text,
 * so a production Android label such as `content-desc="Predicted app: AutoMobile Playground"` pairs
 * with the equivalent iOS text instead of comparing the Android's separate visible label.
 */
private fun accessibleName(node: UIElementInfo): String? =
  node.contentDescription?.takeIf { it.isNotEmpty() } ?: node.text?.takeIf { it.isNotEmpty() }
