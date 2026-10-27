package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class StructuralHasherTest {
  @Test
  fun `volatile extras do not change the hash even on descendants`() {
    val stable = mapOf("sdk.source" to "compose")
    val before =
      stable +
        mapOf(
          "androidx.view.accessibility.AccessibilityNodeInfoCompat.SPANS_START_KEY" to "[]",
          "androidx.view.accessibility.AccessibilityNodeInfoCompat.SPANS_END_KEY" to "[]",
          "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL" to "1",
          "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALAFTER_VAL" to "2",
          "AccessibilityNodeInfo.roleDescription" to "button",
        )
    val after =
      before.mapValues { (_, value) -> "$value-changed" }.toMutableMap().apply { putAll(stable) }
    val root = UIElementInfo(children = listOf(UIElementInfo(extras = before)))

    assertEquals(hash(before), hash(after))
    assertEquals(hash(stable), hash(before))
    assertEquals(
      StructuralHasher.computeHash(ViewHierarchy(hierarchy = root)),
      StructuralHasher.computeHash(
        ViewHierarchy(hierarchy = root.copy(children = listOf(UIElementInfo(extras = after)))),
      ),
    )
  }

  @Test
  fun `all other extras still participate in the hash`() {
    val keys =
      listOf(
        "semantics.testTag",
        "androidx.compose.ui.semantics.testTag",
        "androidx.compose.ui.semantics.TestTag",
        "androidx.compose.ui.testTag",
        "testTag",
        "test-tag",
        "custom.TESTTAG.alias",
        "com.example.EXTRA_DATA_TEST_TRAVERSAL_MODE",
        "EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL",
        "sdk.source",
        "androidx.view.accessibility.AccessibilityNodeInfoCompat.STATE_DESCRIPTION_KEY",
        "androidx.view.accessibility.AccessibilityNodeInfoCompat.BOOLEAN_PROPERTY_KEY",
        "automobile:imePackage",
        RecompositionStore.RECOMPOSITION_ID_KEY,
      )
    for (key in keys) {
      assertNotEquals(key, hash(mapOf(key to "before")), hash(mapOf(key to "after")))
    }
  }

  @Test
  fun `kept entry hash equals Map hashCode regardless of order or volatile entries`() {
    val extras = linkedMapOf("sdk.source" to "compose", "test-tag" to "submit")
    val reordered = extras.entries.reversed().associate { it.toPair() }
    val mixed = reordered + ("AccessibilityNodeInfo.roleDescription" to "button")

    assertEquals(extras.hashCode(), VolatileExtras.structuralHash(extras))
    assertEquals(extras.hashCode(), VolatileExtras.structuralHash(mixed))
    assertEquals(hash(extras), hash(reordered))
    assertEquals(hash(extras), hash(mixed))
    // Legacy hash for an otherwise empty hierarchy: only extras and its following field differ.
    assertEquals(hash(null) + 31 * extras.hashCode(), hash(extras))
  }

  @Test
  fun `null empty and volatile-only extras preserve the legacy zero contribution`() {
    assertEquals(0, (null as Map<String, String>?).hashCode())
    assertEquals(0, VolatileExtras.structuralHash(null))
    assertEquals(0, VolatileExtras.structuralHash(emptyMap()))
    // The old hasher folds 28 null fields into the element hash, plus package and root.
    assertEquals(-1102156702, hash(null))
    assertEquals(hash(null), hash(emptyMap()))
    assertEquals(hash(null), hash(mapOf("AccessibilityNodeInfo.roleDescription" to "button")))
  }

  private fun hash(extras: Map<String, String>?): Int =
    StructuralHasher.computeHash(ViewHierarchy(hierarchy = UIElementInfo(extras = extras)))
}
