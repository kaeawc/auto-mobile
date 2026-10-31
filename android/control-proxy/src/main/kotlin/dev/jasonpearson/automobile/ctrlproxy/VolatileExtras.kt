package dev.jasonpearson.automobile.ctrlproxy

/** Accessibility bookkeeping that should not affect wire output or structural change detection. */
internal object VolatileExtras {
  private const val SPANS_PREFIX = "androidx.view.accessibility.AccessibilityNodeInfoCompat.SPANS_"
  private const val COMPAT_BOOLEANS_KEY =
    "androidx.view.accessibility.AccessibilityNodeInfoCompat.BOOLEAN_PROPERTY_KEY"

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

  /**
   * Whether an extra says nothing that should keep a wrapper node when pruning: the never-shipped
   * SPANS keys, and the androidx compat boolean-property bitmask with no bit set. Where the
   * framework lacks a compat property (API 30-33 captures), androidx writes that bitmask on every
   * node it touches, so "0" is the all-false default, not a property (#13956).
   */
  fun isPruningNoise(key: String, value: String): Boolean =
    isNeverShipped(key) || (key == COMPAT_BOOLEANS_KEY && value == "0")

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
