package dev.jasonpearson.automobile.ctrlproxy

import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.ctrlproxy.models.RecompositionEntry
import dev.jasonpearson.automobile.ctrlproxy.models.RecompositionSnapshot
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
internal class ViewHierarchyExtractorExtrasTest : ViewHierarchyExtractorFixtures() {
  private val spansStart = "androidx.view.accessibility.AccessibilityNodeInfoCompat.SPANS_START_KEY"
  private val stateDescriptionKey =
    "androidx.view.accessibility.AccessibilityNodeInfoCompat.STATE_DESCRIPTION_KEY"

  @Test
  fun `SPANS-only bundle produces null extras on the wire`() {
    val node = fakeNode("example.app", text = "Label")
    node.extras.putIntegerArrayList(spansStart, arrayListOf())
    node.extras.putString(
      "androidx.view.accessibility.AccessibilityNodeInfoCompat.SPANS_ACTION_ID_KEY",
      "42",
    )
    try {
      assertNull(extractRaw(node).extras)
    } finally {
      node.recycle()
    }
  }

  @Test
  fun `mixed bundle keeps every non-SPANS entry including hash-volatile metadata`() {
    val node = fakeNode("example.app", text = "Label")
    val kept =
      linkedMapOf(
        "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL" to "3",
        "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALAFTER_VAL" to "5",
        "AccessibilityNodeInfo.roleDescription" to "button",
        "sdk.source" to "compose",
        "automobile:imePackage" to "example.ime",
        "androidx.view.accessibility.AccessibilityNodeInfoCompat.BOOLEAN_PROPERTY_KEY" to "1",
        RecompositionStore.RECOMPOSITION_ID_KEY to "entry",
        // Prefix matching must not accidentally drop similarly named application keys.
        "custom.SPANS_START_KEY" to "application data",
      )
    node.extras.putString(spansStart, "[]")
    kept.forEach { (key, value) -> node.extras.putString(key, value) }
    node.extras.putInt("android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL", 3)
    node.extras.putString("null-value", null)
    try {
      val extras = extractRaw(node).extras
      assertEquals(kept, extras)
      val store = RecompositionStore()
      val entry = RecompositionEntry("entry")
      store.setEnabled(true)
      store.updateSnapshot(RecompositionSnapshot(1L, "example.app", listOf(entry)))
      assertEquals(entry, store.findMatch(extras))
    } finally {
      node.recycle()
    }
  }

  @Test
  @Config(sdk = [29])
  fun `test tag aliases and state description still resolve next to SPANS extras`() {
    val aliases =
      listOf(
        "androidx.compose.ui.semantics.testTag",
        "androidx.compose.ui.semantics.TestTag",
        "androidx.compose.ui.testTag",
        "testTag",
        "test-tag",
        "custom.TESTTAG.alias",
      )
    for (alias in aliases) {
      val node = fakeNode("example.app")
      node.extras.putString(spansStart, "[]")
      node.extras.putString(alias, "submit")
      node.extras.putString(stateDescriptionKey, "On")
      try {
        val extracted = extractRaw(node)
        assertEquals(alias, "submit", extracted.testTag)
        assertEquals("On", extracted.stateDescription)
        assertEquals(mapOf(alias to "submit", stateDescriptionKey to "On"), extracted.extras)
        // The selector reads the original Bundle independently of hierarchy extraction.
        assertEquals("submit", extractTestTag(node))
      } finally {
        node.recycle()
      }
    }
  }

  @Test
  fun `SPANS-only extras no longer keep empty nodes meaningful but real extras do`() {
    val noiseOnly = fakeNode("example.app")
    val meaningful = fakeNode("example.app")
    noiseOnly.extras.putString(spansStart, "[]")
    meaningful.extras.putString(spansStart, "[]")
    meaningful.extras.putString("sdk.source", "compose")
    try {
      assertNull(extractor.extractFromActiveWindow(noiseOnly)!!.hierarchy)
      val hierarchy = extractor.extractFromActiveWindow(meaningful)!!.hierarchy
      assertNotNull(hierarchy)
      val kept = json.decodeFromJsonElement(UIElementInfo.serializer(), hierarchy!!.node!!)
      assertEquals(mapOf("sdk.source" to "compose"), kept.extras)
    } finally {
      noiseOnly.recycle()
      meaningful.recycle()
    }
  }

  private fun extractRaw(node: AccessibilityNodeInfo): UIElementInfo {
    val result =
      extractor.extractFromActiveWindow(
        node,
        options = HierarchyExtractionOptions(disableAllFiltering = true),
      )!!
    assertNull(result.error)
    return json.decodeFromJsonElement(UIElementInfo.serializer(), result.hierarchy!!.node!!)
  }
}
