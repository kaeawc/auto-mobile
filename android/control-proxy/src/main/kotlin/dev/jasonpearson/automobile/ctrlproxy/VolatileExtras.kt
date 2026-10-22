package dev.jasonpearson.automobile.ctrlproxy

/** Accessibility bookkeeping that should not affect wire output or structural change detection. */
internal object VolatileExtras {
  private const val SPANS_PREFIX = "androidx.view.accessibility.AccessibilityNodeInfoCompat.SPANS_"

  /**
   * The framework's traversal-order test extras, matched exactly so a provider's own key that
   * merely contains `EXTRA_DATA_TEST_TRAVERSAL` keeps changing the hash (#14428).
   */
  private val TRAVERSAL_KEYS =
    setOf(
      "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL",
      "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALAFTER_VAL",
    )

  fun isNeverShipped(key: String): Boolean = key.startsWith(SPANS_PREFIX)

  fun isHashVolatile(key: String): Boolean =
    isNeverShipped(key) || key in TRAVERSAL_KEYS || key == "AccessibilityNodeInfo.roleDescription"

  /** Map.hashCode sums entry hashes, so kept entries retain the same order-independent hash. */
  fun structuralHash(extras: Map<String, String>?): Int {
    var hash = 0
    extras?.forEach { (key, value) ->
      if (!isHashVolatile(key)) hash += key.hashCode() xor value.hashCode()
    }
    return hash
  }
}
