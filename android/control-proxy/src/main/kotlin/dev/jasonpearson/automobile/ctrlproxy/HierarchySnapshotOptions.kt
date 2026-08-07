package dev.jasonpearson.automobile.ctrlproxy

/**
 * Limits and cancellation hook for one accessibility hierarchy snapshot.
 *
 * The defaults preserve the existing extractor behavior. Callers that expose snapshots to a
 * remote client can provide tighter limits without changing the shape of the extracted nodes.
 */
data class HierarchySnapshotOptions(
  val maxDepth: Int = 100,
  val maxNodes: Int = 10_000,
  val isCancelled: () -> Boolean = { false },
) {
  init {
    require(maxDepth >= 0) { "maxDepth must be >= 0" }
    require(maxNodes > 0) { "maxNodes must be > 0" }
  }
}

internal class HierarchySnapshotBudget(private val options: HierarchySnapshotOptions) {
  private var nodes = 0
  private val reasons = linkedSetOf<String>()

  fun enter(depth: Int): Boolean {
    if (options.isCancelled()) {
      reasons += "cancelled"
      return false
    }
    if (depth > options.maxDepth) {
      reasons += "max_depth"
      return false
    }
    if (nodes >= options.maxNodes) {
      reasons += "max_nodes"
      return false
    }
    nodes += 1
    return true
  }

  fun truncationReasons(): List<String> = reasons.toList()
}
