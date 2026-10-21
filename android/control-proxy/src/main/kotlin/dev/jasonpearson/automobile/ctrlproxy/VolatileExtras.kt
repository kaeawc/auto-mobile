package dev.jasonpearson.automobile.ctrlproxy

/** Accessibility bookkeeping that should not affect wire output or structural change detection. */
internal object VolatileExtras {
  private const val SPANS_PREFIX = "androidx.view.accessibility.AccessibilityNodeInfoCompat.SPANS_"

  fun isNeverShipped(key: String): Boolean = key.startsWith(SPANS_PREFIX)

  fun isHashVolatile(key: String): Boolean =
    isNeverShipped(key) ||
      key.contains("EXTRA_DATA_TEST_TRAVERSAL") ||
      key == "AccessibilityNodeInfo.roleDescription"

  /** Map.hashCode sums entry hashes, so kept entries retain the same order-independent hash. */
  fun structuralHash(extras: Map<String, String>?): Int {
    var hash = 0
    extras?.forEach { (key, value) ->
      if (!isHashVolatile(key)) hash += key.hashCode() xor value.hashCode()
    }
    return hash
  }
}
