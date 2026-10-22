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
  fun `property enables pruning only for exact lowercase true`() {
    for (value in listOf("true", "false", "TRUE", "True", "1", "", " true", "true ", null)) {
      val reads = mutableListOf<String>()
      val warnings = mutableListOf<String>()
      val enabled =
        readBaselineWrapperPruningEnabled(
          readProperty = { key ->
            reads += key
            value
          },
          warn = { message, _ -> warnings += message },
        )

      assertEquals(value == "true", enabled)
      assertEquals(listOf("debug.am.prune_wrappers"), reads)
      assertTrue(warnings.isEmpty())
    }
  }

  @Test
  fun `unavailable or blocked system property warns and defaults off`() {
    for (failure in
      listOf(ClassNotFoundException("SystemProperties"), SecurityException("blocked"))) {
      val warnings = mutableListOf<Pair<String, Throwable>>()
      val enabled =
        readBaselineWrapperPruningEnabled(
          readProperty = { throw failure },
          warn = { message, error -> warnings += message to error },
        )

      assertFalse(enabled)
      assertEquals(1, warnings.size)
      assertTrue(warnings.single().first.contains("debug.am.prune_wrappers"))
      assertSame(failure, warnings.single().second)
    }
  }

  @Test
  fun `enabled keeps a TalkBack-focused node that exposes only baseline actions`() {
    val enabled = ViewHierarchyExtractor(pruneBaselineWrappers = true)
    for (action in listOf("accessibility_focus", "clear_accessibility_focus")) {
      val focused = UIElementInfo(actions = listOf(action), accessibilityFocused = "true")
      assertEquals(action, listOf(focused), enabled.optimizeHierarchy(focused))
    }
  }

  @Test
  fun `the opt-in property name fits the pre-O 31-character limit`() {
    assertTrue(BASELINE_WRAPPER_PRUNING_PROPERTY.length <= 31)
  }

  private fun baselineNode(children: List<UIElementInfo> = emptyList()): UIElementInfo =
    UIElementInfo(actions = baselineActions, extras = spansOnlyExtras, children = children)
}
