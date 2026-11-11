package dev.jasonpearson.automobile.protocol

/** Existence index for overlaps' segment-prefix and {index} rules. */
internal class PrototypeSensitiveSinkIndex(
  taints: List<String>,
  private val visit: () -> Boolean,
) {
  companion object {
    private const val INDEX_WILDCARD = "{index}"

    fun overlaps(taint: String, pointer: String, pointerIndexWildcard: Boolean): Boolean =
      pointerSegments(taint).zip(pointerSegments(pointer)).all { (left, right) ->
        left == right || left == INDEX_WILDCARD || isPointerWildcard(right, pointerIndexWildcard)
      }

    private fun pointerSegments(pointer: String): List<String> = pointer.drop(1).split('/')

    private fun isPointerWildcard(segment: String, pointerIndexWildcard: Boolean): Boolean =
      pointerIndexWildcard && segment == INDEX_WILDCARD
  }

  class Budget(private val limit: Int) {
    var checks = 0
      private set

    fun visit(): Boolean {
      if (checks > limit) return false
      checks += 1
      return checks <= limit
    }
  }

  private class TaintNode {
    val children = mutableMapOf<String, TaintNode>()
    var terminal = false
    var hasTaintBelow = false
  }

  private val root = TaintNode()

  init {
    for (taint in taints) {
      var node = root
      node.hasTaintBelow = true
      for (segment in pointerSegments(taint)) {
        node = node.children.getOrPut(segment) { TaintNode() }
        node.hasTaintBelow = true
      }
      node.terminal = true
    }
  }

  fun overlaps(pointer: String, pointerIndexWildcard: Boolean): Boolean {
    val segments = pointerSegments(pointer)
    fun walk(node: TaintNode, depth: Int): Boolean {
      if (!visit()) return false
      if (node.terminal || depth == segments.size) return node.hasTaintBelow
      val segment = segments[depth]
      if (isPointerWildcard(segment, pointerIndexWildcard)) {
        return node.children.values.any { walk(it, depth + 1) }
      }
      if (node.children[segment]?.let { walk(it, depth + 1) } == true) return true
      return segment != INDEX_WILDCARD &&
        node.children[INDEX_WILDCARD]?.let { walk(it, depth + 1) } == true
    }
    return walk(root, 0)
  }

  fun isTaintedPointer(pointer: String?): Boolean =
    pointer != null && PrototypeDataPointer.isValid(pointer) && overlaps(pointer, false)
}

/** State templates may name any runtime key sharing the literal prefix before their first brace. */
internal class PrototypeStateTaintIndex(
  private val taints: List<String>,
  private val visit: () -> Boolean,
) {
  companion object {
    private fun prefix(key: String): String? = key.indexOf('{').takeIf { it >= 0 }?.let(key::take)

    fun overlaps(left: String, right: String): Boolean {
      val leftPrefix = prefix(left)
      val rightPrefix = prefix(right)
      return when {
        leftPrefix == null && rightPrefix == null -> left == right
        leftPrefix == null -> left.startsWith(checkNotNull(rightPrefix))
        rightPrefix == null -> right.startsWith(leftPrefix)
        else -> leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix)
      }
    }
  }

  private val literal = taints.filter { prefix(it) == null }.toSet()
  private val templated = taints.filter { prefix(it) != null }

  fun key(key: String): Boolean {
    if (!visit()) return false
    if (prefix(key) == null && key in literal) return true
    val candidates = if (prefix(key) == null) templated else taints
    return candidates.any { visit() && overlaps(it, key) }
  }

  fun text(text: String): Boolean =
    '{' in text && taints.any { visit() && text.contains("{${prefix(it) ?: "$it}"}") }
}
