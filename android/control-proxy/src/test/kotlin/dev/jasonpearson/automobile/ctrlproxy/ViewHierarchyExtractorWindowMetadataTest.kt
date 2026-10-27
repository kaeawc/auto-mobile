package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.util.SparseArray
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.ctrlproxy.models.WindowInfo
import dev.jasonpearson.automobile.ctrlproxy.prototype.PROTOTYPE_WINDOW_TITLE
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeWindowMetadata
import dev.jasonpearson.automobile.protocol.PrototypeAppearance
import dev.jasonpearson.automobile.protocol.PrototypeAppearanceMode
import dev.jasonpearson.automobile.protocol.PrototypeAppearanceSource
import dev.jasonpearson.automobile.protocol.PrototypeHiddenReason
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class ViewHierarchyExtractorWindowMetadataTest : ViewHierarchyExtractorFixtures() {

  @Test
  fun `prototype presence precedes content filtering and null roots remain unknown`() {
    val calls = mutableListOf<Boolean?>()
    val extractor =
      ViewHierarchyExtractor(
        prototypeHiddenReason = { _, captured ->
          calls += captured
          null
        },
      )
    val ownPackage = "dev.jasonpearson.automobile.ctrlproxy"
    for (root in listOf(fakeNode(ownPackage), null)) {
      val frame =
        extractor.extractFromAllWindows(
          listOf(
            fakeWindow(
              1,
              1,
              root,
              state =
                WindowState(
                  type = AccessibilityWindowInfo.TYPE_SYSTEM,
                  title = PROTOTYPE_WINDOW_TITLE,
                ),
            ),
          ),
          null,
        )
      assertEquals(if (root == null) null else true, calls.last())
      assertNull(frame.hierarchy)
    }
  }

  @Test
  fun `filtered prototype beside readable app is still captured`() {
    val calls = mutableListOf<Boolean?>()
    val extractor =
      ViewHierarchyExtractor(
        prototypeHiddenReason = { _, captured ->
          calls += captured
          null
        },
      )
    val frame =
      extractor.extractFromAllWindows(
        listOf(
          fakeWindow(1, 0, fakeNode("app.example", text = "App")),
          fakeWindow(
            2,
            1,
            fakeNode("dev.jasonpearson.automobile.ctrlproxy"),
            state =
              WindowState(
                type = AccessibilityWindowInfo.TYPE_SYSTEM,
                title = PROTOTYPE_WINDOW_TITLE,
              ),
          ),
        ),
        null,
      )
    assertEquals(listOf(true), calls)
    assertEquals(listOf("App"), frame.hierarchy?.children?.map { it.text })
  }

  @Test
  fun `hidden provider receives captured own window presence and single root unknown`() {
    val calls = mutableListOf<Pair<Int, Boolean?>>()
    val extractor =
      ViewHierarchyExtractor(
        prototypeHiddenReason = { display, captured ->
          calls += display to captured
          PrototypeHiddenReason.APP_LAYER_WINDOW_HIDDEN
        },
      )
    val ownPackage = "dev.jasonpearson.automobile.ctrlproxy"
    for ((pkg, title, expected) in
      listOf(
        Triple(ownPackage, PROTOTYPE_WINDOW_TITLE, true),
        Triple("com.android.systemui", PROTOTYPE_WINDOW_TITLE, false),
        Triple(ownPackage, "Highlight", false),
      )) {
      val frame =
        extractor.extractFromAllWindows(
          listOf(
            fakeWindow(
              1,
              1,
              fakeNode(pkg, text = "Window"),
              state = WindowState(type = AccessibilityWindowInfo.TYPE_SYSTEM, title = title),
            ),
          ),
          null,
          options =
            HierarchyExtractionOptions(
              disableAllFiltering = true,
              displayId = 2,
            ),
        )
      assertEquals(2 to expected, calls.last())
      assertEquals(PrototypeHiddenReason.APP_LAYER_WINDOW_HIDDEN, frame.prototypeHiddenReason)
    }
    val single =
      extractor.extractFromActiveWindow(
        fakeNode("app.example", text = "Root"),
        options = HierarchyExtractionOptions(displayId = 3),
      )
    assertEquals(3 to null, calls.last())
    assertEquals(PrototypeHiddenReason.APP_LAYER_WINDOW_HIDDEN, single?.prototypeHiddenReason)
  }

  @Test
  fun `concurrent prototype windows receive metadata for their own title only`() {
    val own = "dev.jasonpearson.automobile.ctrlproxy"
    val metadata =
      mapOf(
        "AutoMobile Prototype:full" to PrototypeWindowMetadata("fullscreen", true),
        "AutoMobile Prototype:sheet" to PrototypeWindowMetadata("sheet", false),
        "AutoMobile Prototype:float" to PrototypeWindowMetadata("floating", false),
        PROTOTYPE_WINDOW_TITLE to PrototypeWindowMetadata("sheet", false),
      )
    val stamping =
      ViewHierarchyExtractor(
        ownPrototypeMetadata = { pkg, title ->
          if (pkg == own) metadata[title?.toString()] else null
        },
      )
    val titles = metadata.keys.toList() + "AutoMobile Highlight"
    val result =
      stamping.extractFromAllWindows(
        titles.mapIndexed { index, title ->
          fakeWindow(
            index + 1,
            index,
            fakeNode(
              packageName = own,
              text = title,
              state = NodeState(bounds = Rect(0, index * 300, 1080, index * 300 + 200)),
            ),
            state =
              WindowState(
                type = AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY,
                bounds = Rect(0, index * 300, 1080, index * 300 + 200),
                title = title,
              ),
          )
        } + foreignMetadataOverlay(),
        null,
      )
    for ((index, title) in titles.withIndex()) {
      val window = result.windows!!.single { it.id == index + 1 }
      assertEquals(metadata[title]?.placement, window.prototypePlacement)
      assertEquals(metadata[title]?.opaque, window.prototypeOpaque)
      assertEquals(listOf("full", "sheet", "float", null, null)[index], window.prototypeId)
    }
    val foreign = result.windows!!.single { it.id == 6 }
    assertNull(foreign.prototypePlacement)
    assertNull(foreign.prototypeOpaque)
    assertNull(foreign.prototypeId)
  }

  private fun foreignMetadataOverlay(): AccessibilityWindowInfo =
    fakeWindow(
      6,
      6,
      fakeNode(
        packageName = "other",
        text = "foreign",
        state = NodeState(bounds = Rect(0, 1800, 1080, 2000)),
      ),
      state =
        WindowState(
          type = AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY,
          bounds = Rect(0, 1800, 1080, 2000),
          title = "AutoMobile Prototype:full",
        ),
    )

  @Test
  fun `window extraction selects only the requested display roots`() {
    val inner =
      fakeWindow(
        201,
        0,
        fakeNode(packageName = "app.inner", text = "Inner"),
        state = WindowState(focused = true),
      )
    val cover = fakeWindow(202, 0, fakeNode(packageName = "app.cover", text = "Cover"))
    val all =
      SparseArray<List<AccessibilityWindowInfo>>().apply {
        put(0, listOf(inner))
        put(2, listOf(cover))
      }

    assertEquals(0, extractor.targetDisplayId(all))
    assertEquals(2, extractor.targetDisplayId(all, requestedDisplayId = 2))
    val selected = extractor.windowsForDisplay(all, 2)
    val hierarchy =
      extractor.extractFromAllWindows(
        selected,
        null,
        options =
          HierarchyExtractionOptions(
            disableAllFiltering = true,
            displayId = 2,
            panelUniqueId = "panel-cover",
          ),
      )
    val serialized = json.encodeToString(ViewHierarchy.serializer(), hierarchy)
    assertTrue(serialized.contains("Cover"))
    assertFalse(serialized.contains("Inner"))
    assertEquals(2, hierarchy.windows?.single()?.displayId)
    assertEquals("panel-cover", hierarchy.windows?.single()?.panelUniqueId)
  }

  @Test
  fun `window entries report the package of their root node`() {
    val app = fakeWindow(1, 0, fakeNode(packageName = "app.main", text = "Main"))
    val overlay =
      fakeWindow(
        2,
        1,
        fakeNode(packageName = "dev.jasonpearson.automobile.ctrlproxy", text = "Overlay"),
        state =
          WindowState(type = AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY, focused = true),
      )

    val hierarchy =
      extractor.extractFromAllWindows(
        listOf(app, overlay),
        null,
        options = HierarchyExtractionOptions(disableAllFiltering = true),
      )

    assertEquals(
      mapOf(1 to "app.main", 2 to "dev.jasonpearson.automobile.ctrlproxy"),
      hierarchy.windows?.associate { it.id to it.packageName },
    )
  }

  @Test
  fun `window entry package round trips and is omitted from the wire when null`() {
    val withPackage = WindowInfo(id = 2, type = 4, isFocused = true, packageName = "app.main")
    val withoutPackage = WindowInfo(id = 3, type = 1)

    // encodeDefaults = true: the null package must still be dropped by @EncodeDefault(NEVER).
    val wire = Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
    }
    val encodedWith = wire.encodeToString(WindowInfo.serializer(), withPackage)
    val encodedWithout = wire.encodeToString(WindowInfo.serializer(), withoutPackage)

    assertTrue(encodedWith.contains("\"packageName\":\"app.main\""))
    assertFalse(encodedWithout.contains("packageName"))
    assertEquals(withPackage, wire.decodeFromString(WindowInfo.serializer(), encodedWith))
    assertEquals(withoutPackage, wire.decodeFromString(WindowInfo.serializer(), encodedWithout))
    // An older APK's entry, which never sent the field, still decodes.
    assertNull(
      wire
        .decodeFromString(WindowInfo.serializer(), """{"id":3,"type":1,"isActive":false}""")
        .packageName,
    )
  }

  @Test
  fun `active default display wins over focused virtual display`() {
    val phone =
      fakeWindow(
        1,
        0,
        fakeNode(packageName = "phone", text = "Phone"),
        state = WindowState(active = true),
      )
    val virtual =
      fakeWindow(2, 0, fakeNode(packageName = "virtual"), state = WindowState(focused = true))
    val all =
      SparseArray<List<AccessibilityWindowInfo>>().apply {
        put(0, listOf(phone))
        put(2, listOf(virtual))
      }
    assertEquals(0, extractor.targetDisplayId(all))
    assertEquals("Phone", extractor.rootForDisplay(virtual.root, listOf(phone), 0)?.text)
  }

  @Test
  fun `phone window selection includes IME from either display bucket`() {
    val phone =
      fakeWindow(1, 0, fakeNode(packageName = "phone"), state = WindowState(focused = true))
    val localIme =
      fakeWindow(
        2,
        1,
        fakeNode(packageName = "ime"),
        state = WindowState(type = AccessibilityWindowInfo.TYPE_INPUT_METHOD),
      )
    val shiftedIme =
      fakeWindow(
        3,
        1,
        fakeNode(packageName = "ime"),
        state = WindowState(type = AccessibilityWindowInfo.TYPE_INPUT_METHOD),
      )
    val systemUi =
      fakeWindow(
        4,
        2,
        fakeNode(packageName = "com.android.systemui"),
        state = WindowState(type = AccessibilityWindowInfo.TYPE_SYSTEM),
      )
    val all =
      SparseArray<List<AccessibilityWindowInfo>>().apply {
        put(0, listOf(phone, localIme))
        put(2, listOf(shiftedIme, systemUi))
      }
    assertEquals(listOf(1, 2, 3, 4), extractor.windowsForDisplay(all, 0).map { it.id })
    assertEquals(listOf(3, 4), extractor.windowsForDisplay(all, 2).map { it.id })
  }

  /**
   * A floating overlay window covering one app row, as in the #10608/#10544 repro (p7/p8): the
   * row's bounds lie wholly inside the overlay's root.
   */
  private fun coveredRowExtraction(
    overlayType: Int,
    overlayPackage: String,
    overlayTitle: CharSequence?,
    extractor: ViewHierarchyExtractor = this.extractor,
  ): ViewHierarchy {
    val app =
      fakeNode(
        packageName = "example.app",
        text = "App",
        state =
          NodeState(
            bounds = Rect(0, 0, 1080, 2400),
            children =
              listOf(
                fakeNode(
                  "example.app",
                  text = "Visible row",
                  state = NodeState(bounds = Rect(0, 200, 1080, 400)),
                ),
                fakeNode(
                  "example.app",
                  text = "Covered row",
                  state = NodeState(bounds = Rect(100, 1000, 980, 1200)),
                ),
              ),
          ),
      )
    val overlay =
      fakeNode(
        packageName = overlayPackage,
        text = "Overlay card",
        state = NodeState(bounds = Rect(0, 900, 1080, 1400)),
      )
    return extractor.extractFromAllWindows(
      listOf(
        fakeWindow(1, 0, app, state = WindowState(focused = true, active = true)),
        fakeWindow(
          2,
          5,
          overlay,
          state =
            WindowState(
              type = overlayType,
              bounds = Rect(0, 900, 1080, 1400),
              title = overlayTitle,
            ),
        ),
      ),
      null,
    )
  }

  @Test
  fun `own prototype windows of either layer do not prune covered app rows`() {
    // The app layer's TYPE_APPLICATION_OVERLAY window reports as TYPE_SYSTEM (#10544).
    for (type in
      listOf(
        AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY,
        AccessibilityWindowInfo.TYPE_SYSTEM,
      )) {
      val result =
        coveredRowExtraction(
          type,
          "dev.jasonpearson.automobile.ctrlproxy",
          PROTOTYPE_WINDOW_TITLE,
        )
      val serialized = json.encodeToString(ViewHierarchy.serializer(), result)
      assertTrue("type $type", serialized.contains("Covered row"))
      assertFalse("type $type", serialized.contains("\"occlusionState\":\"hidden\""))
      assertTrue("type $type", serialized.contains("Overlay card"))
    }
  }

  @Test
  fun `third-party and highlight overlays still prune covered app rows`() {
    for ((type, pkg, title) in
      listOf(
        Triple(AccessibilityWindowInfo.TYPE_SYSTEM, "com.android.systemui", "NotificationShade"),
        Triple(AccessibilityWindowInfo.TYPE_SYSTEM, "com.android.systemui", null),
        // CtrlProxy's highlight overlay keeps today's behaviour: only the prototype title skips.
        Triple(
          AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY,
          "dev.jasonpearson.automobile.ctrlproxy",
          "AutoMobile Overlay",
        ),
        // The prototype title on an application window is not a prototype window.
        Triple(
          AccessibilityWindowInfo.TYPE_APPLICATION,
          "other.app",
          PROTOTYPE_WINDOW_TITLE,
        ),
      )) {
      val serialized =
        json.encodeToString(ViewHierarchy.serializer(), coveredRowExtraction(type, pkg, title))
      assertFalse("$type $title", serialized.contains("Covered row"))
      assertTrue("$type $title", serialized.contains("Visible row"))
    }
  }

  @Test
  fun `prototype metadata is stamped on both prototype layers but never on SystemUI windows`() {
    val asked = mutableListOf<Pair<String?, String?>>()
    val appearance =
      PrototypeAppearance(
        PrototypeAppearanceMode.DARK,
        PrototypeAppearanceSource.OVERRIDE,
        deviceDark = false,
      )
    val stamping =
      ViewHierarchyExtractor(
        ownPrototypeMetadata = { pkg, title ->
          asked += pkg to title?.toString()
          PrototypeWindowMetadata("floating", opaque = false, appearance = appearance)
        },
      )
    val own = "dev.jasonpearson.automobile.ctrlproxy"
    for (type in
      listOf(
        AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY,
        AccessibilityWindowInfo.TYPE_SYSTEM,
      )) {
      val window =
        coveredRowExtraction(type, own, PROTOTYPE_WINDOW_TITLE, stamping).windows!!.single {
          it.id == 2
        }
      assertEquals("type $type", "floating", window.prototypePlacement)
      assertEquals("type $type", false, window.prototypeOpaque)
      assertEquals("type $type", appearance, window.prototypeAppearance)
    }
    assertEquals(List(2) { own to PROTOTYPE_WINDOW_TITLE }, asked)

    asked.clear()
    for (title in listOf("NotificationShade", "StatusBar", null)) {
      val window =
        coveredRowExtraction(
            AccessibilityWindowInfo.TYPE_SYSTEM,
            "com.android.systemui",
            title,
            stamping,
          )
          .windows!!
          .single { it.id == 2 }
      assertNull(window.prototypePlacement)
      assertNull(window.prototypeOpaque)
      assertNull(window.prototypeAppearance)
    }
    assertTrue(asked.isEmpty())
  }
}
