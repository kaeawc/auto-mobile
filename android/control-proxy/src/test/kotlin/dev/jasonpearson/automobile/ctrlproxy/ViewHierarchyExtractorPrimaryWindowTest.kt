package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class ViewHierarchyExtractorPrimaryWindowTest : ViewHierarchyExtractorFixtures() {

  @Test
  fun `pickPrimaryAppWindowId prefers focused application over higher-layer system window`() {
    // Regression for #5971: on API 34, a status bar window can be marked active while the
    // foreground Settings window is the only focused application window.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 10,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 5,
          hasRoot = true,
          isFocused = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 11,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 6,
          hasRoot = true,
        ),
      )
    assertEquals(10, extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId preserves focused app selection when its root is unavailable`() {
    // Regression for #5981: do not fall back to an active status-bar window when the focused
    // application temporarily has no accessible root.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 10,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 5,
          hasRoot = false,
          isFocused = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 11,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 6,
          hasRoot = true,
        ),
      )
    assertEquals(10, extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId leaves active-window fallback when a system window owns focus`() {
    // Genuine system UI: an expanded shade / quick settings / keyguard reports isFocused, and
    // the app beneath it must not be promoted over it (the systemTray workflow observes the
    // shade).
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 10,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 5,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 11,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 6,
          hasRoot = true,
          isFocused = true,
        ),
      )
    assertNull(extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId prefers an app window with content when no window reports focus`() {
    // Regression for #6151: when the isFocused flag is populated nowhere, the topmost application
    // window with a root outranks a status bar that merely happens to be marked active.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 10,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 5,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 11,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 6,
          hasRoot = true,
        ),
      )
    assertEquals(10, extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId prefers the active app over a higher-layer app when no window reports focus`() {
    // Split-screen / picture-in-picture with the focus flag populated nowhere: the resumed
    // (active) application must win over a merely topmost one, so mainPackageName agrees with
    // adb's resumed package and freshness is not retracted against the wrong app.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 10,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 1,
          hasRoot = true,
          isActive = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 12,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 3,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 11,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 6,
          hasRoot = true,
        ),
      )
    assertEquals(10, extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId selects a focused permission dialog over the app beneath it`() {
    // API 34 shape with a runtime permission dialog in front: the permissioncontroller dialog
    // is its own focused TYPE_APPLICATION window layered above the (unfocused) app window.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 219,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 2,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 318,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 0,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 322,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 1,
          hasRoot = true,
          isFocused = true,
        ),
      )
    assertEquals(322, extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId selects a focused Settings sub-panel over the status bar`() {
    // API 34 shape with the Settings Wi-Fi picker in front (dumpsys accessibility ground truth
    // from #6151): status bar TYPE_SYSTEM layer 1, Settings window focused+active layer 0.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 219,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 1,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 256,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 0,
          hasRoot = true,
          isFocused = true,
        ),
      )
    assertEquals(256, extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId keeps the active-window fallback for a status bar alone`() {
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 219,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 1,
          hasRoot = true,
        ),
      )
    assertNull(extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `extractFromAllWindows detects a notification permission dialog in a non-primary window`() {
    // #6151: the flag exists to catch this dialog, so it must be computed from whichever window
    // carries it. Here the app window (still focused, as observed mid-transition) is primary and
    // the permissioncontroller dialog is a second, unfocused application window.
    val appRoot =
      fakeNode(
        packageName = "com.google.android.contacts",
        state =
          NodeState(
            bounds = Rect(0, 0, 1080, 2400),
            children =
              listOf(fakeNode(packageName = "com.google.android.contacts", text = "Contacts")),
          ),
      )
    val dialogRoot = notificationPermissionDialogRoot()
    val windows =
      listOf(
        fakeWindow(id = 318, layer = 0, root = appRoot, state = WindowState(focused = true)),
        fakeWindow(id = 322, layer = 1, root = dialogRoot, state = WindowState(active = true)),
      )

    val result =
      extractor.extractFromAllWindows(
        windows,
        appRoot,
        options = HierarchyExtractionOptions(occlusionEnabled = false),
      )

    assertEquals(true, result.notificationPermissionDetected)
    assertEquals("com.google.android.contacts", result.packageName)
    assertNull(result.ctrlProxyIncomplete)
    val serialized = json.encodeToString(ViewHierarchy.serializer(), result)
    assertTrue(serialized.contains("permission_allow_button"))
    assertTrue(serialized.contains("Allow Contacts to send you notifications?"))

    // An unfocused, inactive permissioncontroller window beside the app (another app's dialog
    // in split-screen) must not flag this app's observation as a permission dialog.
    val bystander =
      listOf(
        fakeWindow(
          id = 318,
          layer = 0,
          root = appRoot,
          state = WindowState(focused = true, active = true),
        ),
        fakeWindow(id = 322, layer = 1, root = dialogRoot),
      )
    val bystanderResult =
      extractor.extractFromAllWindows(
        bystander,
        appRoot,
        options = HierarchyExtractionOptions(occlusionEnabled = false),
      )
    assertEquals(false, bystanderResult.notificationPermissionDetected)
  }

  private fun notificationPermissionDialogRoot(): android.view.accessibility.AccessibilityNodeInfo =
    fakeNode(
      packageName = "com.google.android.permissioncontroller",
      state =
        NodeState(
          bounds = Rect(28, 682, 1052, 1654),
          children =
            listOf(
              fakeNode(
                packageName = "com.google.android.permissioncontroller",
                text = "Allow Contacts to send you notifications?",
                state = NodeState(bounds = Rect(100, 700, 1000, 800)),
              ),
              fakeNode(
                packageName = "com.google.android.permissioncontroller",
                text = "Allow",
                resourceId = "com.android.permissioncontroller:id/permission_allow_button",
                state = NodeState(bounds = Rect(100, 1500, 500, 1600)),
              ),
              fakeNode(
                packageName = "com.google.android.permissioncontroller",
                text = "Don't allow",
                resourceId = "com.android.permissioncontroller:id/permission_deny_button",
                state = NodeState(bounds = Rect(600, 1500, 1000, 1600)),
              ),
            ),
        ),
    )

  @Test
  fun `extractFromAllWindows does not flag an unrelated app's active dialog in a split-screen pane`() {
    // #6151 follow-up: `canCarryDialog` used to accept ANY focused-or-active permissioncontroller
    // window, so a foreign app's own active dialog in the other split-screen pane could still set
    // the primary app's `notificationPermissionDetected`. Here App A (primary, focused) occupies
    // the top half of the screen; App B's own active permission dialog occupies the bottom half —
    // a disjoint region, so it does not overlap App A's window and must not be correlated with it.
    val appARoot =
      fakeNode(
        packageName = "com.google.android.contacts",
        state =
          NodeState(
            bounds = Rect(0, 0, 1080, 1200),
            children =
              listOf(fakeNode(packageName = "com.google.android.contacts", text = "Contacts")),
          ),
      )
    val foreignDialogRoot =
      fakeNode(
        packageName = "com.google.android.permissioncontroller",
        state =
          NodeState(
            bounds = Rect(28, 1300, 1052, 2300),
            children =
              listOf(
                fakeNode(
                  packageName = "com.google.android.permissioncontroller",
                  text = "Allow Maps to send you notifications?",
                  state = NodeState(bounds = Rect(100, 1350, 1000, 1450)),
                ),
                fakeNode(
                  packageName = "com.google.android.permissioncontroller",
                  text = "Allow",
                  resourceId = "com.android.permissioncontroller:id/permission_allow_button",
                  state = NodeState(bounds = Rect(100, 2100, 500, 2200)),
                ),
              ),
          ),
      )
    val windows =
      listOf(
        fakeWindow(
          id = 318,
          layer = 0,
          root = appARoot,
          state = WindowState(focused = true, bounds = Rect(0, 0, 1080, 1200)),
        ),
        fakeWindow(
          id = 322,
          layer = 0,
          root = foreignDialogRoot,
          state = WindowState(active = true, bounds = Rect(0, 1200, 1080, 2400)),
        ),
      )

    val result =
      extractor.extractFromAllWindows(
        windows,
        appARoot,
        options = HierarchyExtractionOptions(occlusionEnabled = false),
      )

    assertEquals(false, result.notificationPermissionDetected)
    assertEquals("com.google.android.contacts", result.packageName)
  }

  @Test
  fun `pickPrimaryAppWindowId returns topmost app window when IME is up`() {
    // Reproduces the Gboard-over-Slack scenario observed on a Pixel 10 Pro:
    // the IME has isActive=true (owns input focus) and the app window has isActive=false,
    // so the extractor must not rely on isActive to find the user-facing app.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 42,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 1,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 99,
          type = AccessibilityWindowInfo.TYPE_INPUT_METHOD,
          layer = 10,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 7,
          type = AccessibilityWindowInfo.TYPE_SYSTEM,
          layer = 20,
          hasRoot = true,
        ),
      )
    assertEquals(42, extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId ignores IME with null root`() {
    // An IME window present in the windows list but without a root cannot contribute
    // occlusion and should not trigger the IME primary-window remap. The IME owns focus here
    // (the keyboard-showing shape), so the no-focus-anywhere rule (#6151) does not apply either.
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 42,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 1,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 99,
          type = AccessibilityWindowInfo.TYPE_INPUT_METHOD,
          layer = 10,
          hasRoot = false,
          isFocused = true,
        ),
      )
    assertNull(extractor.pickPrimaryAppWindowId(windows))
  }

  @Test
  fun `pickPrimaryAppWindowId picks highest-layer app window among multiple`() {
    val windows =
      listOf(
        ViewHierarchyExtractor.WindowMeta(
          id = 1,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 1,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 2,
          type = AccessibilityWindowInfo.TYPE_APPLICATION,
          layer = 3,
          hasRoot = true,
        ),
        ViewHierarchyExtractor.WindowMeta(
          id = 99,
          type = AccessibilityWindowInfo.TYPE_INPUT_METHOD,
          layer = 10,
          hasRoot = true,
        ),
      )
    assertEquals(2, extractor.pickPrimaryAppWindowId(windows))
  }
}
