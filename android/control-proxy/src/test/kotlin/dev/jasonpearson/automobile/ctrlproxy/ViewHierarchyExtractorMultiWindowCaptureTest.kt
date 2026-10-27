package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class ViewHierarchyExtractorMultiWindowCaptureTest : ViewHierarchyExtractorFixtures() {

  @Test
  fun `extractFromAllWindows reports an incomplete capture when the focused app root is withheld`() {
    // The #6151 device shape before the isAccessibilityTool declaration: the status bar has a
    // root, the focused Settings window does not, and rootInActiveWindow is null too. The
    // capture must be flagged incomplete with no package rather than labelled as app content.
    val statusBarRoot =
      fakeNode(
        packageName = "com.android.systemui",
        state =
          NodeState(
            bounds = Rect(0, 0, 1080, 63),
            children =
              listOf(
                fakeNode(
                  packageName = "com.android.systemui",
                  text = "8:33",
                  resourceId = "com.android.systemui:id/clock",
                  state = NodeState(bounds = Rect(21, 0, 107, 63)),
                ),
              ),
          ),
      )
    val windows =
      listOf(
        fakeWindow(
          id = 219,
          layer = 1,
          root = statusBarRoot,
          state = WindowState(type = AccessibilityWindowInfo.TYPE_SYSTEM),
        ),
        fakeWindow(
          id = 256,
          layer = 0,
          root = null,
          state = WindowState(focused = true, active = true),
        ),
      )

    val result =
      extractor.extractFromAllWindows(
        windows,
        null,
        options = HierarchyExtractionOptions(occlusionEnabled = false),
      )

    assertEquals(true, result.ctrlProxyIncomplete)
    // All three causes hold; active-window withholding takes precedence.
    assertEquals("active_window_null_root", result.ctrlProxyIncompleteReason)
    assertNull(result.packageName)
    assertNotNull(result.hierarchy)
    val serialized = json.encodeToString(ViewHierarchy.serializer(), result)
    assertTrue(serialized.contains("com.android.systemui:id/clock"))
  }

  @Test
  fun `active null root wins even when an app window is readable`() {
    val app = fakeNode(packageName = "example.app", text = "Readable")
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 0, app, state = WindowState(focused = true)),
          fakeWindow(
            2,
            1,
            null,
            state = WindowState(type = AccessibilityWindowInfo.TYPE_SYSTEM, active = true),
          ),
        ),
        null,
        options =
          HierarchyExtractionOptions(
            occlusionEnabled = false,
          ),
      )
    assertEquals(true, result.ctrlProxyIncomplete)
    assertEquals("active_window_null_root", result.ctrlProxyIncompleteReason)
  }

  @Test
  fun `selected app null root wins over no accessible app window`() {
    val bar = fakeNode(packageName = "com.android.systemui", text = "Clock")
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(
            1,
            1,
            bar,
            state = WindowState(type = AccessibilityWindowInfo.TYPE_SYSTEM, active = true),
          ),
          fakeWindow(2, 0, null, state = WindowState(focused = true)),
        ),
        null,
        options =
          HierarchyExtractionOptions(
            occlusionEnabled = false,
          ),
      )
    assertEquals(true, result.ctrlProxyIncomplete)
    assertEquals("app_window_null_root", result.ctrlProxyIncompleteReason)
  }

  @Test
  fun `non SystemUI foreground without app windows reports no app root`() {
    val overlay = fakeNode(packageName = "example.overlay", text = "Overlay")
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(
            1,
            0,
            overlay,
            state =
              WindowState(type = AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY, active = true),
          ),
        ),
        null,
        options =
          HierarchyExtractionOptions(
            occlusionEnabled = false,
          ),
      )
    assertEquals("example.overlay", result.packageName)
    assertEquals(true, result.ctrlProxyIncomplete)
    assertEquals("no_app_window_root", result.ctrlProxyIncompleteReason)
  }

  @Test
  fun `complete app capture omits incompleteness metadata`() {
    val app = fakeNode(packageName = "example.app", text = "Readable")
    val result =
      extractor.extractFromAllWindows(
        listOf(fakeWindow(1, 0, app, state = WindowState(focused = true, active = true))),
        null,
        options =
          HierarchyExtractionOptions(
            occlusionEnabled = false,
          ),
      )
    assertNotNull(result.hierarchy)
    assertNull(result.ctrlProxyIncomplete)
    assertNull(result.ctrlProxyIncompleteReason)
  }

  @Test
  fun `SystemUI foreground without app windows remains complete`() {
    val shade = fakeNode(packageName = "com.android.systemui", text = "Notifications")
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(
            1,
            0,
            shade,
            state =
              WindowState(
                type = AccessibilityWindowInfo.TYPE_SYSTEM,
                focused = true,
                active = true,
              ),
          ),
        ),
        null,
        options =
          HierarchyExtractionOptions(
            occlusionEnabled = false,
          ),
      )
    assertEquals("com.android.systemui", result.packageName)
    assertNotNull(result.hierarchy)
    assertNull(result.ctrlProxyIncomplete)
    assertNull(result.ctrlProxyIncompleteReason)
  }

  @Test
  fun `unified hierarchy preserves IME subtree identity and raw key detail`() {
    val appRoot = fakeNode(packageName = "example.keyboard", text = "Settings")
    val imeRoot =
      fakeNode(
        packageName = "example.keyboard",
        text = "Keyboard",
        state =
          NodeState(children = listOf(fakeNode(packageName = "example.keyboard", text = "Q"))),
      )
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(id = 1, layer = 0, root = appRoot, state = WindowState(focused = true)),
          fakeWindow(
            id = 2,
            layer = 1,
            root = imeRoot,
            state = WindowState(type = AccessibilityWindowInfo.TYPE_INPUT_METHOD),
          ),
        ),
        appRoot,
        options =
          HierarchyExtractionOptions(
            disableAllFiltering = true,
            occlusionEnabled = false,
          ),
      )
    val roots = result.hierarchy!!.node as kotlinx.serialization.json.JsonArray
    val app = roots[0] as kotlinx.serialization.json.JsonObject
    val ime = roots[1] as kotlinx.serialization.json.JsonObject
    assertNull(app["extras"])
    assertEquals(
      kotlinx.serialization.json.JsonPrimitive("example.keyboard"),
      (ime["extras"] as kotlinx.serialization.json.JsonObject)["automobile:imePackage"],
    )
    assertTrue(ime.toString().contains("\"Q\""))
  }

  @Test
  fun `wire roots retain exact window ownership and layer independently of focus`() {
    val app = fakeNode(packageName = "example.app", text = "Duplicate")
    val overlay = fakeNode(packageName = "example.app", text = "Duplicate")
    val result =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(id = 23, layer = 7, root = overlay),
          fakeWindow(
            id = 24,
            layer = 2,
            root = app,
            state = WindowState(focused = true, active = true),
          ),
        ),
        app,
        options =
          HierarchyExtractionOptions(
            disableAllFiltering = true,
            occlusionEnabled = false,
          ),
      )
    val encoded =
      json.encodeToJsonElement(ViewHierarchy.serializer(), result)
        as kotlinx.serialization.json.JsonObject
    val metadata = encoded["windows"] as kotlinx.serialization.json.JsonArray
    val roots = result.hierarchy!!.node as kotlinx.serialization.json.JsonArray
    assertEquals(
      kotlinx.serialization.json.JsonPrimitive(24),
      (roots[0] as kotlinx.serialization.json.JsonObject)["windowId"],
    )
    assertEquals(
      kotlinx.serialization.json.JsonPrimitive(23),
      (roots[1] as kotlinx.serialization.json.JsonObject)["windowId"],
    )
    assertEquals(
      kotlinx.serialization.json.JsonPrimitive(7),
      (metadata[0] as kotlinx.serialization.json.JsonObject)["windowLayer"],
    )
    assertEquals(
      kotlinx.serialization.json.JsonPrimitive(2),
      (metadata[1] as kotlinx.serialization.json.JsonObject)["windowLayer"],
    )
  }

  @Test
  fun `fallback root retains matching window metadata`() {
    val app = fakeNode(packageName = "example.app", text = "Fallback")
    val result =
      extractor.extractFromAllWindows(
        emptyList(),
        app,
        options = HierarchyExtractionOptions(disableAllFiltering = true),
      )
    val root = result.hierarchy!!.node as kotlinx.serialization.json.JsonObject
    val encoded =
      json.encodeToJsonElement(ViewHierarchy.serializer(), result)
        as kotlinx.serialization.json.JsonObject
    val windows = encoded["windows"] as? kotlinx.serialization.json.JsonArray
    assertNotNull(windows)
    val metadata = windows!!.single() as kotlinx.serialization.json.JsonObject
    assertEquals(root["windowId"], metadata["id"])
    assertEquals(kotlinx.serialization.json.JsonPrimitive(0), metadata["windowLayer"])
  }

  @Test
  fun `fallback replaces an already extracted active window instead of duplicating its ownership`() {
    val activeRoot = fakeNode(packageName = "example.app", text = "Active content")
    val windows =
      listOf(
        fakeWindow(id = 41, layer = 0, root = null, state = WindowState(focused = true)),
        fakeWindow(id = 42, layer = 2, root = activeRoot, state = WindowState(active = true)),
      )
    val result =
      extractor.extractFromAllWindows(
        windows,
        activeRoot,
        options =
          HierarchyExtractionOptions(
            disableAllFiltering = true,
            occlusionEnabled = false,
          ),
      )
    val encoded =
      json.encodeToJsonElement(ViewHierarchy.serializer(), result)
        as kotlinx.serialization.json.JsonObject
    val root = result.hierarchy!!.node as kotlinx.serialization.json.JsonObject
    assertEquals(kotlinx.serialization.json.JsonPrimitive(42), root["windowId"])
    assertNotNull(encoded["windows"])
  }
}
