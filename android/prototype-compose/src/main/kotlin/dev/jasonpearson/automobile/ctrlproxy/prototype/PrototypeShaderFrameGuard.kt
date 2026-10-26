package dev.jasonpearson.automobile.ctrlproxy.prototype

/**
 * Allocation-free frame sampling until failure. Pass frame-clock timestamps (or an injected fake
 * clock); pauses reset sampling, but a disabled node never recovers during this prototype's life.
 */
@InternalAutoMobilePrototypeApi
class PrototypeShaderFrameGuard(
  private val clockNanos: () -> Long = System::nanoTime,
  private val budgetNanos: Long = 24_000_000L,
  private val consecutiveLimit: Int = 8,
) {
  init {
    require(budgetNanos > 0 && consecutiveLimit > 0)
  }

  @Volatile
  var disabledReason: String? = null
    private set

  private var previousNanos = 0L
  private var sampled = false
  private var overBudget = 0

  fun frame(nowNanos: Long = clockNanos()): Boolean {
    if (disabledReason != null) return false
    val previous = previousNanos
    previousNanos = nowNanos
    if (!sampled) {
      sampled = true
      return true
    }
    overBudget = if (nowNanos > previous && nowNanos - previous > budgetNanos) overBudget + 1 else 0
    if (overBudget >= consecutiveLimit) {
      disable(
        "Shader disabled: $consecutiveLimit consecutive frame intervals exceeded ${budgetNanos / 1_000_000} ms.",
      )
    }
    return disabledReason == null
  }

  fun pause() {
    sampled = false
    overBudget = 0
  }

  fun disable(reason: String) {
    if (disabledReason == null) disabledReason = boundedPrototypeShaderError(reason)
  }
}

/** Owned by the runtime rather than composition, including for nodes temporarily removed/hidden. */
@InternalAutoMobilePrototypeApi
class PrototypeShaderSession {
  private val guards = mutableMapOf<String, PrototypeShaderFrameGuard>()

  @Synchronized
  fun guard(node: String): PrototypeShaderFrameGuard =
    guards.getOrPut(node) { PrototypeShaderFrameGuard() }

  @Synchronized
  fun failures(): Map<String, String> =
    guards
      .mapNotNull { (node, guard) ->
        guard.disabledReason?.let { node to it }
      }
      .toMap()
}
