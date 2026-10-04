package dev.jasonpearson.automobile.ctrlproxy

/**
 * Limits and cancellation hook for one accessibility hierarchy snapshot.
 *
 * The defaults preserve the existing extractor behavior. Callers that expose snapshots to a remote
 * client can provide tighter limits without changing the shape of the extracted nodes.
 */
data class HierarchySnapshotOptions(
  val maxDepth: Int = 100,
  val maxNodes: Int = 10_000,
  val displayId: Int? = null,
  val isCancelled: () -> Boolean = { false },
) {
  init {
    require(maxDepth >= 0) { "maxDepth must be >= 0" }
    require(maxNodes > 0) { "maxNodes must be > 0" }
  }
}

/** Sequential window scopes share the cap while protecting reservations for later scopes. */
internal class HierarchySnapshotBudget
private constructor(
  private val shared: SharedBudget,
  private val nodeLimit: Int,
  private val isScope: Boolean,
) {
  constructor(
    options: HierarchySnapshotOptions,
    slotCount: Int = 1,
  ) : this(SharedBudget(options, slotCount), options.maxNodes, false)

  private class SharedBudget(val options: HierarchySnapshotOptions, slotCount: Int) {
    init {
      require(slotCount > 0) { "slotCount must be > 0" }
    }

    var nodes = 0
    var remainingSlots = slotCount
    var scopeOpen = false
    // Long arithmetic avoids overflow for a large caller-provided slot count.
    val reservation = maxOf(1, (options.maxNodes.toLong() / (2L * slotCount)).toInt())
    val reasons = linkedSetOf<String>()
  }

  private val reasons = linkedSetOf<String>()
  private var finished = false

  /** Only one scope may be open: unused nodes become available to the next scope on finish. */
  fun openScope(reserved: Boolean = true): HierarchySnapshotBudget {
    check(!isScope && !shared.scopeOpen)
    if (reserved) {
      check(shared.remainingSlots > 0)
      shared.remainingSlots -= 1
    }
    shared.scopeOpen = true
    // When there are fewer nodes than slots, prioritize later slots (including fallback) without
    // ever exceeding the cap. A one-node guarantee for every slot is then mathematically
    // impossible.
    val held =
      minOf(shared.options.maxNodes.toLong(), shared.remainingSlots.toLong() * shared.reservation)
        .toInt()
    return HierarchySnapshotBudget(shared, shared.options.maxNodes - held, true)
  }

  /** Finish even a skipped/null-root scope. Repeated calls are harmless. */
  fun finish() {
    if (isScope && !finished) {
      finished = true
      shared.scopeOpen = false
    }
  }

  fun <T> inScope(reserved: Boolean = true, block: (HierarchySnapshotBudget) -> T): T {
    val scope = openScope(reserved)
    return try {
      block(scope)
    } finally {
      scope.finish()
    }
  }

  fun enter(depth: Int): Boolean {
    check(!finished && (isScope || !shared.scopeOpen))
    val reason =
      when {
        shared.options.isCancelled() -> "cancelled"
        depth > shared.options.maxDepth -> "max_depth"
        shared.nodes >= nodeLimit -> "max_nodes"
        else -> null
      }
    if (reason != null) {
      reasons += reason
      shared.reasons += reason
      return false
    }
    shared.nodes += 1
    return true
  }

  fun recordChildCapTruncation() {
    reasons += "max_children"
    shared.reasons += "max_children"
  }

  fun truncationReasons(): List<String> = (if (isScope) reasons else shared.reasons).toList()
}
