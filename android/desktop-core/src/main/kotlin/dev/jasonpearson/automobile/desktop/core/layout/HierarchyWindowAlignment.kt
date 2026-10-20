package dev.jasonpearson.automobile.desktop.core.layout

/** Index role-mode trees with order-preserving, cross-side child slots. */
internal fun indexAlignedWindows(
  windowsA: List<UIElementInfo>,
  slotsA: IntArray,
  windowsB: List<UIElementInfo>,
  slotsB: IntArray,
  keyMode: DiffKeyMode,
): Pair<LinkedHashMap<String, UIElementInfo>, LinkedHashMap<String, UIElementInfo>> {
  val mapA = LinkedHashMap<String, UIElementInfo>()
  val mapB = LinkedHashMap<String, UIElementInfo>()
  addAlignedChildren(
    dev.jasonpearson.automobile.desktop.core.layout.AlignedHierarchyChildren(
      mapA,
      mapB,
      windowsA,
      slotsA,
      windowsB,
      slotsB,
      "",
      null,
      null,
      keyMode,
    ),
  )
  return mapA to mapB
}

internal fun addAlignedChildren(options: AlignedHierarchyChildren) {
  with(options) {
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
        dev.jasonpearson.automobile.desktop.core.layout.AlignedHierarchyChildren(
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
        ),
      )
    }
  }
}

/** Needleman-Wunsch alignment that only pairs siblings with the same structural role. */
internal fun alignChildSlots(
  childrenA: List<UIElementInfo>,
  childrenB: List<UIElementInfo>,
  parentRoleA: StructuralRole?,
  parentRoleB: StructuralRole?,
): Pair<IntArray, IntArray> {
  return alignSequenceSlots(
    childrenA.size,
    childrenB.size,
    similarity = { i, j ->
      val a = childrenA[i]
      val b = childrenB[j]
      if (structuralRoleOf(a, parentRoleA) != structuralRoleOf(b, parentRoleB))
        Double.NEGATIVE_INFINITY
      else if (accessibleName(a) == accessibleName(b)) 2.0 else 1.0
    },
  )
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
internal fun alignWindowSlots(
  windowsA: List<UIElementInfo>,
  windowsB: List<UIElementInfo>,
  keyMode: DiffKeyMode,
): Pair<IntArray, IntArray> {
  if (windowsA.size <= 1 && windowsB.size <= 1)
    return IntArray(windowsA.size) to IntArray(windowsB.size)
  val signaturesA = windowsA.map { signatureKeys(it, keyMode) }
  val signaturesB = windowsB.map { signatureKeys(it, keyMode) }
  val canonicalA = signaturesA.map { canonicalSignature(it) }
  val canonicalB = signaturesB.map { canonicalSignature(it) }
  return alignSequenceSlots(
    windowsA.size,
    windowsB.size,
    similarity = { i, j -> jaccard(signaturesA[i], signaturesB[j]) },
    preferSkipA = { i, j, skipA, skipB ->
      when {
        j == 0 -> true
        i == 0 -> false
        skipA > skipB -> true
        skipB > skipA -> false
        else -> canonicalA[i - 1] <= canonicalB[j - 1]
      }
    },
  )
}
