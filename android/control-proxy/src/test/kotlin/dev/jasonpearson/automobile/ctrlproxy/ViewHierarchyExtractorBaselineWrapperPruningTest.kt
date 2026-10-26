package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

internal class ViewHierarchyExtractorBaselineWrapperPruningTest : ViewHierarchyExtractorFixtures() {
  companion object {
    @BeforeClass
    @JvmStatic
    fun warmUpCodecAndActionTable() {
      // Exclude one-time class loading from individual unit-test timings.
      val label = UIElementInfo(text = "Warmup")
      ViewHierarchyExtractor(pruneBaselineWrappers = true)
        .optimizeHierarchy(
          UIElementInfo(actions = listOf("select"), children = listOf(label)),
        )
      Json.encodeToString(
        UIElementInfo.serializer(),
        WireNodeCodec.materialize(UIElementInfo(children = listOf(label))),
      )
    }
  }

  // Deliberately independent of the production set so changes to its membership fail these tests.
  private val baselineActions =
    listOf("select", "clear_selection", "accessibility_focus", "clear_accessibility_focus")
  private val spansOnlyExtras =
    mapOf("androidx.view.accessibility.AccessibilityNodeInfoCompat.SPANS_START_KEY" to "[]")

  @Test
  fun `default and explicit off preserve baseline wrapper and empty leaf`() {
    val wrapper = baselineNode(children = listOf(UIElementInfo(text = "Label"), baselineNode()))

    assertEquals(listOf(wrapper), extractor.optimizeHierarchy(wrapper))
    assertEquals(
      listOf(wrapper),
      ViewHierarchyExtractor(pruneBaselineWrappers = false).optimizeHierarchy(wrapper),
    )
  }

  @Test
  fun `enabled promotes text child and drops empty baseline leaf`() {
    val label = UIElementInfo(text = "Label")
    val wrapper = baselineNode(children = listOf(label, baselineNode()))
    val enabled = ViewHierarchyExtractor(pruneBaselineWrappers = true)

    assertEquals(listOf(label), enabled.optimizeHierarchy(wrapper))
    assertTrue(enabled.optimizeHierarchy(baselineNode()).isEmpty())
  }

  @Test
  fun `enabled ignores each baseline action alone and SPANS-only extras alone`() {
    val enabled = ViewHierarchyExtractor(pruneBaselineWrappers = true)
    for (action in baselineActions) {
      assertTrue(enabled.optimizeHierarchy(UIElementInfo(actions = listOf(action))).isEmpty())
    }
    assertTrue(enabled.optimizeHierarchy(UIElementInfo(extras = spansOnlyExtras)).isEmpty())
    assertTrue(
      enabled
        .optimizeHierarchy(UIElementInfo(actions = emptyList(), extras = emptyMap()))
        .isEmpty(),
    )
  }

  @Test
  fun `enabled preserves accessibility focused baseline-only leaves and their parents`() {
    val enabled = ViewHierarchyExtractor(pruneBaselineWrappers = true)
    val focusedNode = baselineNode().copy(accessibilityFocused = "true")
    val wrapper = baselineNode(children = listOf(focusedNode)).copy(resourceId = "wrapper")

    assertEquals(listOf(focusedNode), enabled.optimizeHierarchy(focusedNode))
    assertTrue(enabled.optimizeHierarchy(baselineNode()).isEmpty())
    assertEquals(listOf(wrapper), enabled.optimizeHierarchy(wrapper))
  }

  @Test
  fun `enabled preserves every real action even alongside baseline actions`() {
    val enabled = ViewHierarchyExtractor(pruneBaselineWrappers = true)
    for (action in listOf("click", "scroll_forward", "set_text")) {
      val wrapper =
        baselineNode(children = listOf(UIElementInfo(text = "Action child")))
          .copy(actions = baselineActions + action)
      assertEquals(action, listOf(wrapper), enabled.optimizeHierarchy(wrapper))
    }
  }

  @Test
  fun `enabled preserves non-SPANS extras including hash-volatile and lookalike keys`() {
    val enabled = ViewHierarchyExtractor(pruneBaselineWrappers = true)
    for (key in
      listOf(
        "app.metadata",
        "AccessibilityNodeInfo.roleDescription",
        "custom.SPANS_START_KEY",
      )) {
      val wrapper =
        baselineNode(children = listOf(UIElementInfo(text = "Extra child")))
          .copy(extras = spansOnlyExtras + (key to "value"))
      assertEquals(key, listOf(wrapper), enabled.optimizeHierarchy(wrapper))
    }
  }

  @Test
  fun `enabled never drops or flattens a node a selector can name or a tap can reach`() {
    val enabled = ViewHierarchyExtractor(pruneBaselineWrappers = true)
    val relevant =
      mapOf<String, (UIElementInfo) -> UIElementInfo>(
        "resource-id" to { it.copy(resourceId = "app:id/row") },
        "text" to { it.copy(text = "Label") },
        "content-desc" to { it.copy(contentDesc = "Close") },
        "test-tag" to { it.copy(testTag = "row") },
        "clickable flag" to { it.copy(clickable = "true") },
        "long-clickable flag" to { it.copy(longClickable = "true") },
        "click action" to { it.copy(actions = baselineActions + "click") },
        "long-click action" to { it.copy(actions = baselineActions + "long_click") },
      )
    for ((name, mark) in relevant) {
      val leaf = mark(baselineNode())
      assertEquals("$name leaf", listOf(leaf), enabled.optimizeHierarchy(leaf))
      val parent = mark(baselineNode(children = listOf(baselineNode(), UIElementInfo(text = "x"))))
      val kept = enabled.optimizeHierarchy(parent).single()
      assertEquals("$name parent keeps its own fields", parent.copy(children = kept.children), kept)
      assertEquals("$name parent keeps the text child", listOf(UIElementInfo(text = "x")), kept.children)
    }
  }

  @Test
  fun `interactive baseline-only parent keeps its text child`() {
    val wrapper =
      baselineNode(children = listOf(UIElementInfo(text = "Tab label"))).copy(clickable = "true")

    assertEquals(
      listOf(wrapper),
      ViewHierarchyExtractor(pruneBaselineWrappers = true).optimizeHierarchy(wrapper),
    )
  }

  @Test
  fun `off serialized mixed tree matches legacy golden byte for byte`() {
    val input =
      UIElementInfo(
        text = "Root",
        children =
          listOf(
            baselineNode(children = listOf(UIElementInfo(text = "Wrapped"))),
            baselineNode(),
            UIElementInfo(
              children = listOf(UIElementInfo(text = "Promoted"), UIElementInfo()),
            ),
            UIElementInfo(
              clickable = "true",
              children =
                listOf(
                  UIElementInfo(children = listOf(UIElementInfo(text = "Tab"))),
                ),
            ),
          ),
      )
    // Hand-written from the legacy algorithm: baseline wrappers/leaves stay, bounds-only
    // wrappers flatten, empty bounds-only leaves drop, and the clickable parent stays.
    val expected =
      """
      {"text":"Root","node":[
      {"actions":["select","clear_selection","accessibility_focus","clear_accessibility_focus"],
      "extras":{"androidx.view.accessibility.AccessibilityNodeInfoCompat.SPANS_START_KEY":"[]"},
      "node":{"text":"Wrapped"}},
      {"actions":["select","clear_selection","accessibility_focus","clear_accessibility_focus"],
      "extras":{"androidx.view.accessibility.AccessibilityNodeInfoCompat.SPANS_START_KEY":"[]"}},
      {"text":"Promoted"},{"clickable":"true","node":{"text":"Tab"}}]}
      """
        .trimIndent()
        .lineSequence()
        .joinToString("") { it.trim() }

    for (candidate in listOf(extractor, ViewHierarchyExtractor(pruneBaselineWrappers = false))) {
      val result = candidate.optimizeHierarchy(input).single()
      assertEquals(
        expected,
        json.encodeToString(UIElementInfo.serializer(), WireNodeCodec.materialize(result)),
      )
    }
  }

  @Test
  fun `pruning is on from API 30 and off below it by default`() {
    for ((sdkInt, expected) in
      listOf(24 to false, 29 to false, 30 to true, 33 to true, 36 to true, 37 to true)) {
      val enabled =
        readBaselineWrapperPruningEnabled(
          readProperty = { null },
          sdkInt = sdkInt,
          warn = { _, _ -> },
        )
      assertEquals("sdk $sdkInt", expected, enabled)
    }
  }

  @Test
  fun `property overrides the API default only for exact lowercase true or false`() {
    for (sdkInt in listOf(28, 36)) {
      for (value in listOf("true", "false", "TRUE", "False", "1", "", " true", "true ", null)) {
        val reads = mutableListOf<String>()
        val warnings = mutableListOf<String>()
        val enabled =
          readBaselineWrapperPruningEnabled(
            readProperty = { key ->
              reads += key
              value
            },
            sdkInt = sdkInt,
            warn = { message, _ -> warnings += message },
          )

        val expected =
          when (value) {
            "true" -> true
            "false" -> false
            else -> sdkInt >= 30
          }
        assertEquals("sdk $sdkInt value '$value'", expected, enabled)
        assertEquals(listOf(BASELINE_WRAPPER_PRUNING_PROPERTY), reads)
        assertTrue(warnings.isEmpty())
      }
    }
  }

  @Test
  fun `unavailable or blocked system property warns and keeps the API default`() {
    for (failure in
      listOf(ClassNotFoundException("SystemProperties"), SecurityException("blocked"))) {
      for ((sdkInt, expected) in listOf(29 to false, 36 to true)) {
        val warnings = mutableListOf<Pair<String, Throwable>>()
        val enabled =
          readBaselineWrapperPruningEnabled(
            readProperty = { throw failure },
            sdkInt = sdkInt,
            warn = { message, error -> warnings += message to error },
          )

        assertEquals(expected, enabled)
        assertEquals(1, warnings.size)
        assertTrue(warnings.single().first.contains(BASELINE_WRAPPER_PRUNING_PROPERTY))
        assertSame(failure, warnings.single().second)
      }
    }
  }

  @Test
  fun `property name fits Android system property limit`() {
    assertTrue(BASELINE_WRAPPER_PRUNING_PROPERTY.length <= 31)
  }

  private fun baselineNode(children: List<UIElementInfo> = emptyList()): UIElementInfo =
    UIElementInfo(actions = baselineActions, extras = spansOnlyExtras, children = children)
}
