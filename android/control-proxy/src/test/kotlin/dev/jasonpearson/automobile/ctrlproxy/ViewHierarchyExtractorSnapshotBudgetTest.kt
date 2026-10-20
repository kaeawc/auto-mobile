package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class ViewHierarchyExtractorSnapshotBudgetTest : ViewHierarchyExtractorFixtures() {

  @Test
  fun `snapshot options reject unsafe bounds`() {
    assertThrows(IllegalArgumentException::class.java) {
      HierarchySnapshotOptions(maxDepth = -1)
    }
    assertThrows(IllegalArgumentException::class.java) {
      HierarchySnapshotOptions(maxNodes = 0)
    }
  }

  @Test
  fun `snapshot budget reports cancellation and limits`() {
    val cancelled = HierarchySnapshotBudget(HierarchySnapshotOptions(isCancelled = { true }))
    assertFalse(cancelled.enter(0))
    assertEquals(listOf("cancelled"), cancelled.truncationReasons())

    val depthLimited = HierarchySnapshotBudget(HierarchySnapshotOptions(maxDepth = 0))
    assertTrue(depthLimited.enter(0))
    assertFalse(depthLimited.enter(1))
    assertEquals(listOf("max_depth"), depthLimited.truncationReasons())

    val nodeLimited = HierarchySnapshotBudget(HierarchySnapshotOptions(maxNodes = 1))
    assertTrue(nodeLimited.enter(0))
    assertFalse(nodeLimited.enter(0))
    assertEquals(listOf("max_nodes"), nodeLimited.truncationReasons())
  }

  @Test
  fun `window scopes reserve nodes for later windows and release unused shares`() {
    val budget = HierarchySnapshotBudget(HierarchySnapshotOptions(maxNodes = 20), slotCount = 3)
    budget.inScope { first ->
      repeat(14) { assertTrue(first.enter(0)) }
      assertFalse(first.enter(0))
      assertEquals(listOf("max_nodes"), first.truncationReasons())
      assertThrows(IllegalStateException::class.java) { budget.openScope() }
    }
    // A null-root window still opens and finishes its slot without consuming nodes.
    budget.inScope { skipped -> assertTrue(skipped.truncationReasons().isEmpty()) }
    budget.inScope { last ->
      repeat(6) { assertTrue(last.enter(0)) }
      assertFalse(last.enter(0))
    }
    assertEquals(listOf("max_nodes"), budget.truncationReasons())
  }

  @Test
  fun `window scopes attribute cancellation and depth without leaking reasons`() {
    var cancelled = false
    val budget =
      HierarchySnapshotBudget(
        HierarchySnapshotOptions(maxNodes = 4, maxDepth = 0, isCancelled = { cancelled }),
        slotCount = 2,
      )
    budget.inScope { first ->
      assertFalse(first.enter(1))
      cancelled = true
      assertFalse(first.enter(1))
      assertEquals(listOf("max_depth", "cancelled"), first.truncationReasons())
    }
    cancelled = false
    budget.inScope { second ->
      repeat(4) { assertTrue(second.enter(0)) }
      assertFalse(second.enter(0))
      assertEquals(listOf("max_nodes"), second.truncationReasons())
    }
    assertEquals(listOf("max_depth", "cancelled", "max_nodes"), budget.truncationReasons())
  }

  @Test
  fun `one slot matches the legacy counter and failure precedence`() {
    var cancelled = false
    val options = HierarchySnapshotOptions(maxNodes = 2, maxDepth = 0, isCancelled = { cancelled })
    val legacy = HierarchySnapshotBudget(options)
    val scoped = HierarchySnapshotBudget(options, slotCount = 1)
    scoped.inScope { scope ->
      repeat(2) {
        assertTrue(legacy.enter(0))
        assertTrue(scope.enter(0))
      }
      // All limits apply: cancellation wins, then depth, then the node cap.
      cancelled = true
      assertFalse(legacy.enter(1))
      assertFalse(scope.enter(1))
      assertEquals(listOf("cancelled"), scope.truncationReasons())
      cancelled = false
      assertFalse(legacy.enter(1))
      assertFalse(scope.enter(1))
      assertEquals(listOf("cancelled", "max_depth"), scope.truncationReasons())
      assertFalse(legacy.enter(0))
      assertFalse(scope.enter(0))
      assertEquals(listOf("cancelled", "max_depth", "max_nodes"), scope.truncationReasons())
      assertEquals(legacy.truncationReasons(), scope.truncationReasons())
    }
    assertEquals(legacy.truncationReasons(), scoped.truncationReasons())
  }

  @Test
  fun `more window slots than nodes never exceeds the global cap`() {
    val budget = HierarchySnapshotBudget(HierarchySnapshotOptions(maxNodes = 2), slotCount = 4)
    var admitted = 0
    repeat(4) {
      budget.inScope { scope ->
        while (scope.enter(0)) admitted += 1
      }
    }
    assertEquals(2, admitted)
    assertEquals(listOf("max_nodes"), budget.truncationReasons())
  }

  @Test
  fun `scope finish releases reservations even when extraction throws`() {
    val budget = HierarchySnapshotBudget(HierarchySnapshotOptions(maxNodes = 6), slotCount = 2)
    assertThrows(IllegalStateException::class.java) {
      budget.inScope<Unit> { throw IllegalStateException("fake extraction failure") }
    }
    budget.inScope { last ->
      repeat(6) { assertTrue(last.enter(0)) }
      assertFalse(last.enter(0))
    }
  }

  @Test
  fun `large first window leaves the later IME complete within the total cap`() {
    val app = budgetTree("App", 40)
    val ime = budgetTree("Keyboard", 2)
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 0, app, state = WindowState(focused = true)),
          fakeWindow(
            2,
            1,
            ime,
            state = WindowState(type = AccessibilityWindowInfo.TYPE_INPUT_METHOD),
          ),
        ),
        null,
        options =
          HierarchyExtractionOptions(
            disableAllFiltering = true,
            snapshotOptions = HierarchySnapshotOptions(maxNodes = 20),
          ),
      )
    val roots = result.hierarchy!!.node as kotlinx.serialization.json.JsonArray
    val imeOutput = roots[1] as kotlinx.serialization.json.JsonObject
    assertEquals(3, countWireNodes(imeOutput))
    assertTrue(imeOutput.toString().contains("Keyboard-1"))
    assertTrue(imeOutput.toString().contains("Keyboard-2"))
    assertNull(result.windows!!.first { it.id == 2 }.truncationReasons)
    assertEquals(listOf("max_nodes"), result.windows.first { it.id == 1 }.truncationReasons)
    assertEquals(listOf("max_nodes"), result.truncationReasons)
    assertTrue(countWireNodes(roots) <= 20)
  }

  @Test
  fun `reserved fallback recovers complete app content after large inactive windows`() {
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(
            1,
            1,
            budgetTree("System", 40),
            state = WindowState(type = AccessibilityWindowInfo.TYPE_SYSTEM),
          ),
          fakeWindow(
            2,
            2,
            budgetTree("Overlay", 40),
            state = WindowState(type = AccessibilityWindowInfo.TYPE_SYSTEM),
          ),
        ),
        budgetTree("Fallback", 2),
        options =
          HierarchyExtractionOptions(
            disableAllFiltering = true,
            snapshotOptions = HierarchySnapshotOptions(maxNodes = 20),
          ),
      )
    assertEquals("example.app", result.packageName)
    val roots = result.hierarchy!!.node as kotlinx.serialization.json.JsonArray
    val fallback =
      roots
        .map { it as kotlinx.serialization.json.JsonObject }
        .first {
          it["windowId"] == kotlinx.serialization.json.JsonPrimitive(-1)
        }
    assertEquals(3, countWireNodes(fallback))
    assertTrue(fallback.toString().contains("Fallback-2"))
    assertNull(result.windows!!.first { it.id == -1 }.truncationReasons)
    assertEquals(listOf("max_nodes"), result.windows.first { it.id == 1 }.truncationReasons)
    assertEquals(listOf("max_nodes"), result.truncationReasons)
    assertTrue(countWireNodes(roots) <= 20)
  }

  @Test
  fun `fallback replacement reports its own reasons and retains the global union`() {
    val discarded =
      fakeNode(
        packageName = "example.app",
        state =
          NodeState(
            bounds = Rect(0, 0, 0, 0),
            children =
              (1..40).map {
                fakeNode(packageName = "example.app", state = NodeState(bounds = Rect(0, 0, 0, 0)))
              },
          ),
      )
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(
            7,
            0,
            discarded,
            state = WindowState(type = AccessibilityWindowInfo.TYPE_SYSTEM, active = true),
          ),
        ),
        budgetTree("Fallback", 2),
        options =
          HierarchyExtractionOptions(
            disableAllFiltering = true,
            snapshotOptions = HierarchySnapshotOptions(maxNodes = 20),
          ),
      )
    assertEquals(3, countWireNodes(result.hierarchy!!.node!!))
    assertEquals(7, result.windows!!.single().id)
    assertNull(result.windows.single().truncationReasons)
    assertEquals(listOf("max_nodes"), result.truncationReasons)
  }

  @Test
  fun `skipped null root releases its reservation for a later window`() {
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 0, budgetTree("First", 40), state = WindowState(focused = true)),
          fakeWindow(2, 1, null),
          fakeWindow(3, 2, budgetTree("Last", 5)),
        ),
        null,
        options =
          HierarchyExtractionOptions(
            disableAllFiltering = true,
            snapshotOptions = HierarchySnapshotOptions(maxNodes = 20),
          ),
      )
    val roots = result.hierarchy!!.node as kotlinx.serialization.json.JsonArray
    assertEquals(6, countWireNodes(roots[1]))
    assertNull(result.windows!!.first { it.id == 3 }.truncationReasons)
    assertTrue(countWireNodes(roots) <= 20)
  }

  @Test
  fun `complete multi-window metadata omits truncation reasons even with encodeDefaults`() {
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 0, budgetTree("App", 2), state = WindowState(focused = true)),
          fakeWindow(
            2,
            1,
            budgetTree("Keyboard", 2),
            state = WindowState(type = AccessibilityWindowInfo.TYPE_INPUT_METHOD),
          ),
        ),
        null,
        options =
          HierarchyExtractionOptions(
            disableAllFiltering = true,
          ),
      )
    val verbose = Json { encodeDefaults = true }
    val encoded =
      verbose.encodeToJsonElement(ViewHierarchy.serializer(), result)
        as kotlinx.serialization.json.JsonObject
    assertFalse(encoded["windows"].toString().contains("truncationReasons"))
    assertNull(result.truncationReasons)
  }

  @Test
  fun `single primary window preserves exact legacy JSON with and without a fallback root`() {
    val childOne =
      """{"text":"One","resource-id":"one","view-id":"one","bounds":{"left":0,"top":100,"right":1080,"bottom":200},"visible-to-user":true}"""
    val childTwo = childOne.replace("One", "Two").replace("one", "two")
    for (limited in listOf(false, true)) {
      for (provideFallback in listOf(false, true)) {
        val root =
          fakeNode(
            packageName = "example.app",
            text = "Root",
            resourceId = "root",
            state =
              NodeState(
                enabled = true,
                children =
                  listOf(
                    fakeNode("example.app", "One", "one", NodeState(enabled = true)),
                    fakeNode(
                      packageName = "example.app",
                      text = "Two",
                      resourceId = "two",
                      state = NodeState(enabled = true),
                    ),
                  ),
              ),
          )
        val result =
          extractor.extractFromAllWindows(
            listOf(fakeWindow(1, 0, root, state = WindowState(focused = true))),
            if (provideFallback) root else null,
            options =
              HierarchyExtractionOptions(
                disableAllFiltering = true,
                snapshotOptions =
                  if (limited) HierarchySnapshotOptions(maxNodes = 2)
                  else HierarchySnapshotOptions(),
              ),
          )
        val children = if (limited) childOne else "[$childOne,$childTwo]"
        val reasons = if (limited) ",\"truncationReasons\":[\"max_nodes\"]" else ""
        // Only the additive attribution (truncation reasons, window package) is removed; every
        // legacy field and its order is checked.
        assertEquals("example.app", result.windows!!.single().packageName)
        val legacy =
          result.copy(
            updatedAt = 0,
            userId = 0,
            windows = result.windows.map { it.copy(truncationReasons = null, packageName = null) },
          )
        val expected =
          """{"updatedAt":0,"packageName":"example.app","userId":0,"hierarchy":{"node":{"text":"Root","windowId":1,"displayId":0,"resource-id":"root","view-id":"root","bounds":{"left":0,"top":100,"right":1080,"bottom":200},"visible-to-user":true,"node":$children}},"windows":[{"id":1,"displayId":0,"type":1,"windowLayer":0,"isFocused":true,"bounds":{"left":0,"top":0,"right":1080,"bottom":2400}}],"intentChooserDetected":false,"notificationPermissionDetected":false$reasons}"""
        assertEquals(expected, json.encodeToString(ViewHierarchy.serializer(), legacy))
        assertEquals(
          if (limited) listOf("max_nodes") else null,
          result.windows.single().truncationReasons,
        )
      }
    }
  }

  @Test
  fun `child cap keeps 256 children and reports only the affected window`() {
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 0, budgetTree("App", 300), state = WindowState(focused = true)),
          fakeWindow(2, 1, budgetTree("Small", 0)),
        ),
        null,
        options =
          HierarchyExtractionOptions(
            disableAllFiltering = true,
          ),
      )
    val roots = result.hierarchy!!.node as kotlinx.serialization.json.JsonArray
    val children =
      (roots[0] as kotlinx.serialization.json.JsonObject)["node"]
        as kotlinx.serialization.json.JsonArray
    assertEquals(256, children.size)
    assertEquals(257, countWireNodes(roots[0]))
    assertEquals(listOf("max_children"), result.windows!!.first { it.id == 1 }.truncationReasons)
    assertNull(result.windows.first { it.id == 2 }.truncationReasons)
    assertEquals(listOf("max_children"), result.truncationReasons)
  }

  @Test
  fun `exactly 256 children remains complete and omits truncation metadata`() {
    val result =
      extractor.extractFromAllWindows(
        listOf(fakeWindow(1, 0, budgetTree("App", 256), state = WindowState(focused = true))),
        null,
        options =
          HierarchyExtractionOptions(
            disableAllFiltering = true,
          ),
      )
    assertEquals(257, countWireNodes(result.hierarchy!!.node!!))
    assertNull(result.windows!!.single().truncationReasons)
    assertNull(result.truncationReasons)
    val encoded =
      Json { encodeDefaults = true }.encodeToJsonElement(ViewHierarchy.serializer(), result)
        as kotlinx.serialization.json.JsonObject
    assertFalse(encoded["windows"].toString().contains("truncationReasons"))
  }

  @Test
  fun `nested child caps are deduplicated per window and snapshot`() {
    val root =
      fakeNode(
        packageName = "example.app",
        text = "Root",
        state = NodeState(children = listOf(budgetTree("First", 300), budgetTree("Second", 300))),
      )
    val result =
      extractor.extractFromAllWindows(
        listOf(fakeWindow(1, 0, root, state = WindowState(focused = true))),
        null,
        options =
          HierarchyExtractionOptions(
            disableAllFiltering = true,
          ),
      )
    assertEquals(515, countWireNodes(result.hierarchy!!.node!!))
    assertEquals(listOf("max_children"), result.windows!!.single().truncationReasons)
    assertEquals(listOf("max_children"), result.truncationReasons)
  }

  @Test
  fun `depth truncation belongs only to the window that exceeds the depth limit`() {
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 0, budgetTree("App", 2), state = WindowState(focused = true)),
          fakeWindow(2, 1, budgetTree("Small", 0)),
        ),
        null,
        options =
          HierarchyExtractionOptions(
            disableAllFiltering = true,
            snapshotOptions = HierarchySnapshotOptions(maxDepth = 0),
          ),
      )
    assertEquals(listOf("max_depth"), result.windows!!.first { it.id == 1 }.truncationReasons)
    assertNull(result.windows.first { it.id == 2 }.truncationReasons)
    assertEquals(listOf("max_depth"), result.truncationReasons)
  }

  @Test
  fun `cancelled windows and fallback retain attribution even when no tree is returned`() {
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(
            1,
            0,
            budgetTree("System", 0),
            state = WindowState(type = AccessibilityWindowInfo.TYPE_SYSTEM),
          ),
        ),
        budgetTree("Fallback", 0),
        options =
          HierarchyExtractionOptions(
            disableAllFiltering = true,
            snapshotOptions = HierarchySnapshotOptions(isCancelled = { true }),
          ),
      )
    assertNull(result.hierarchy)
    assertEquals(listOf("cancelled"), result.truncationReasons)
    assertEquals(listOf(1, -1), result.windows!!.map { it.id })
    assertTrue(result.windows.all { it.truncationReasons == listOf("cancelled") })
  }

  private fun budgetTree(label: String, children: Int) =
    fakeNode(
      packageName = "example.app",
      text = label,
      state =
        NodeState(
          children =
            (1..children).map { fakeNode(packageName = "example.app", text = "$label-$it") },
        ),
    )

  private fun countWireNodes(element: kotlinx.serialization.json.JsonElement): Int =
    when (element) {
      is kotlinx.serialization.json.JsonArray -> element.sumOf { countWireNodes(it) }
      is kotlinx.serialization.json.JsonObject ->
        1 + (element["node"]?.let { countWireNodes(it) } ?: 0)
      else -> 0
    }
}
