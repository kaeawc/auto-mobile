package dev.jasonpearson.automobile.desktop.core.layout

/**
 * The semantic-aware signature key set of a window's subtree, computed independently of the
 * window's slot (the window root sits at sibling index 0). Two windows that are fully equal
 * (structure **and** compared attributes) produce identical key sets, so [jaccard] overlap measures
 * subtree similarity for [alignWindowSlots]. See [collectSignatureKeys].
 */
internal fun signatureKeys(window: UIElementInfo, keyMode: DiffKeyMode): Set<String> {
  val keys = LinkedHashSet<String>()
  collectSignatureKeys(
    dev.jasonpearson.automobile.desktop.core.layout.HierarchySignatureIndex(
      keys,
      window,
      parentKey = "",
      siblingIndex = 0,
      keyMode = keyMode,
      parentRole = null,
    ),
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
internal fun collectSignatureKeys(options: HierarchySignatureIndex) {
  with(options) {
    val role = roleFor(node, keyMode, parentRole)
    val structural = pathKey(parentKey, node, siblingIndex, keyMode, role)
    keys.add("$structural::${semanticDigest(node, keyMode)}")
    node.children.forEachIndexed { index, child ->
      collectSignatureKeys(
        dev.jasonpearson.automobile.desktop.core.layout.HierarchySignatureIndex(
          keys,
          child,
          structural,
          index,
          keyMode,
          role,
        ),
      )
    }
  }
}

/**
 * The compared semantic attributes of a node, joined — the [nodeAttributesDiffer] surface, and it
 * must track that surface per [keyMode]. Same-platform keeps `text` and `contentDescription` as two
 * fields; cross-platform collapses them to the single normalized [accessibleName] so the alignment
 * signatures agree with the role-mode Changed test.
 */
internal fun semanticDigest(node: UIElementInfo, keyMode: DiffKeyMode): String {
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
internal fun canonicalSignature(signature: Set<String>): String =
  signature.sorted().joinToString("\u0000")

/** Jaccard overlap |a ∩ b| / |a ∪ b| of two structural key sets; 0 when both are empty. */
internal fun jaccard(a: Set<String>, b: Set<String>): Double {
  if (a.isEmpty() && b.isEmpty()) return 0.0
  var intersection = 0
  for (key in a) {
    if (key in b) intersection++
  }
  val union = a.size + b.size - intersection
  return if (union == 0) 0.0 else intersection.toDouble() / union.toDouble()
}
